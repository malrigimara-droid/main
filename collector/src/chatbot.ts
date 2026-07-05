// ─── 사장님 챗봇 (루프 2: 경험 수집) ───────────────────────────
//
// 정체성: 만능 비서가 아니라 "가게의 콘텐츠/마케팅 담당".
// 구조 원칙:
//  1. 챗봇이 먼저 묻는다 — 질문은 병목 단계에서 역산 (온톨로지가 질문 생성기)
//  2. 들어오는 모든 메시지는 분류기를 먼저 통과 (risk는 LLM 생성 자체를 차단)
//  3. 에피소드는 추출 즉시 이벤트로 — 콘텐츠 생성의 sourceEpisodeIds에 연결
//  4. 일일 대화 상한 — 비용 폭주는 평균이 아니라 꼬리에서 온다
//  5. 원문(C등급)은 동의 게이트 뒤에 저장, 로그에는 참조만 (파기 용이)

import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import path from "node:path";
import { callClaudeJson } from "./llm.js";
import { appendEvent, readEvents } from "./eventLog.js";
import type { ChatMessageEvent, EpisodeExtractedEvent } from "./eventLog.js";
import { requireConsent, grantAccess } from "./dataLifecycle.js";
import type { Stage } from "./types.js";
import type { StoreInfo } from "./actionLayer.js";

const CHAT_STORE_DIR = process.env.CHAT_STORE_DIR ?? ".store/chats";
const DAILY_CAP = Number(process.env.CHAT_DAILY_CAP ?? 20);

// ── 1. 선제 질문: 병목 단계별 질문 은행 (결정적 회전) ──────────

const QUESTION_BANK: Record<Stage, string[]> = {
  DISCOVER: [
    "사장님, 요즘 처음 오시는 분들은 주로 뭘 보고 찾아오셨대요?",
    "이번 주에 \"여기 처음 알았어요\" 하신 손님 계셨어요? 어떻게 아셨대요?",
    "동네에서 가게 모르는 분들 만나면 보통 뭐라고 소개하세요?",
  ],
  CONVERT: [
    "처음 오신 분들이 제일 많이 물어보는 게 뭐예요?",
    "예약 문의만 하고 안 오신 분들, 보통 뭘 망설이시는 것 같아요?",
    "첫 방문 손님이 \"생각보다 ○○하네요\" 한 말 중에 기억나는 거 있으세요?",
  ],
  RETAIN: [
    "단골분들은 보통 몇 주 만에 다시 오세요?",
    "오늘 재방문 손님 중에 기억에 남는 분 있었어요?",
    "오래 다니시는 분들이 우리 가게를 계속 찾는 이유, 뭐라고 하세요?",
  ],
  REFER: [
    "최근에 친구나 가족 데리고 오신 손님 있었어요?",
    "\"○○가 추천해서 왔어요\" 하신 분, 누가 추천했는지 들으셨어요?",
    "손님이 다른 분한테 우리 가게 소개할 때 뭐라고 말할 것 같으세요?",
  ],
};

export function nextQuestion(storeId: string, bottleneck: Stage, weekSeed?: string): string {
  const seed = weekSeed ?? `${new Date().getFullYear()}-W${Math.ceil(new Date().getDate() / 7)}`;
  const pool = QUESTION_BANK[bottleneck];
  const h = createHash("sha256").update(`${storeId}:${bottleneck}:${seed}`).digest()[0];
  return pool[h % pool.length];
}

/** 발송 기록 (실제 발송은 알림톡/카카오 채널 모듈이 담당) */
export async function sendQuestion(storeId: string, bottleneck: Stage): Promise<string> {
  await requireConsent(storeId);
  const q = nextQuestion(storeId, bottleneck);
  await appendEvent({ type: "chat_message", storeId, actor: "chatbot",
    direction: "to_owner", textRef: await storeChatText(storeId, q) });
  return q;
}

// ── 2. 수신 처리: 분류 → 라우팅 ──────────────────────────────

type Category = "episode" | "photo" | "question" | "off_topic" | "risk";

interface ClassifyOut { category: Category; }
const validateClassify = (o: any): o is ClassifyOut =>
  ["episode", "photo", "question", "off_topic", "risk"].includes(o?.category);

interface EpisodeOut {
  summary: string;             // 비식별 요약 (손님 이름·연락처 금지)
  stageRelevance: Stage;
  usableQuote: string | null;  // 콘텐츠 인용 가능한 사장님 표현 (원문 발췌)
}
const validateEpisode = (o: any): o is EpisodeOut =>
  typeof o?.summary === "string" && ["DISCOVER", "CONVERT", "RETAIN", "REFER"].includes(o?.stageRelevance);

const RISK_REPLY =
  "사장님, 그건 제가 함부로 말씀드리면 안 되는 영역이라서요 (세무·법률·노무는 전문가 영역이에요). " +
  "필요하시면 김이사님께 전달해서 적합한 분을 찾아볼게요. 가게 알리는 일은 계속 제가 챙기겠습니다!";

const OFF_TOPIC_REPLY =
  "하하 그러셨군요. 저는 사장님 가게 알리는 담당이라 그 얘기는 잘 모르지만, " +
  "방금 말씀 중에 가게 이야기 나오면 언제든 콘텐츠로 만들어드릴게요!";

export interface ChatTurnResult {
  category: Category;
  reply: string;
  episodeId?: string;
  capped?: boolean;
}

export async function handleOwnerMessage(opts: {
  store: StoreInfo & { storeId: string };
  bottleneck: Stage;
  text: string;
  llm?: typeof callClaudeJson;   // 테스트 주입용
}): Promise<ChatTurnResult> {
  const { store, text } = opts;
  const llm = opts.llm ?? callClaudeJson;
  await requireConsent(store.storeId);

  // 일일 상한 (꼬리 비용 차단)
  const today = new Date().toISOString().slice(0, 10);
  const todayMsgs = (await readEvents({ storeId: store.storeId, types: ["chat_message"], since: today }))
    .filter((e) => (e as ChatMessageEvent).direction === "from_owner").length;
  if (todayMsgs >= DAILY_CAP) {
    return { category: "off_topic", capped: true,
      reply: "사장님 오늘 이야기 많이 나눴네요! 내일 이어서 들려주세요. 말씀해주신 건 다 정리해두고 있어요." };
  }

  // 수신 기록 + 분류 (Haiku — 저비용 게이트)
  const textRef = await storeChatText(store.storeId, text);
  const { category } = await llm<ClassifyOut>({
    model: process.env.REVIEW_MODEL ?? "claude-haiku-4-5-20251001",
    maxTokens: 100,
    system: "메시지 분류기. JSON만 출력: {\"category\": \"episode|photo|question|off_topic|risk\"}. " +
      "episode=가게/손님 이야기·일화, photo=사진 보냄/사진 얘기, question=마케팅 관련 질문, " +
      "risk=세무·법률·노무·의료 등 전문 조언 요청, off_topic=그 외 잡담.",
    prompt: `업종 ${store.industry} 사장님의 메시지:\n"""${text.slice(0, 500)}"""`,
    validate: validateClassify,
  });
  await appendEvent({ type: "chat_message", storeId: store.storeId, actor: "owner",
    direction: "from_owner", category, textRef });

  // 라우팅
  if (category === "risk") return { category, reply: RISK_REPLY };      // LLM 생성 차단
  if (category === "off_topic") return { category, reply: OFF_TOPIC_REPLY };
  if (category === "photo") {
    const photoId = randomUUID();
    await appendEvent({ type: "photo_received", storeId: store.storeId, actor: "owner", photoId });
    return { category, reply: "사진 잘 받았어요! 분위기 살려서 다듬은 버전 보여드릴게요. (있는 모습 그대로, 보정만 합니다)" };
  }

  // episode: 추출 → 이벤트 → 자연스러운 후속 답변
  if (category === "episode") {
    const ep = await llm<EpisodeOut>({
      model: process.env.REVIEW_MODEL ?? "claude-haiku-4-5-20251001",
      maxTokens: 400,
      system: "사장님 이야기에서 콘텐츠 원료를 추출한다. JSON만: " +
        "{\"summary\",\"stageRelevance\":\"DISCOVER|CONVERT|RETAIN|REFER\",\"usableQuote\"}. " +
        "summary에 손님 이름·연락처 등 개인정보 금지. usableQuote는 사장님 원문에서만 발췌, 없으면 null.",
      prompt: `업종 ${store.industry}, 현재 병목 ${opts.bottleneck}.\n사장님 이야기:\n"""${text.slice(0, 1000)}"""`,
      validate: validateEpisode,
    });
    const episodeId = randomUUID();
    await appendEvent({ type: "episode_extracted", storeId: store.storeId, actor: "system",
      episodeId, source: "owner_chat", stageRelevance: ep.stageRelevance, summary: ep.summary });
    return { category, episodeId,
      reply: "이 이야기 좋네요! 다음 콘텐츠에 녹여볼게요. " +
        (ep.stageRelevance === opts.bottleneck ? "지금 저희가 집중하는 부분이랑 딱 맞는 이야기예요." : "잘 보관해둘게요.") };
  }

  // question: 마케팅 질문 — 역할 범위 내 답변 (Sonnet, 짧게)
  const ans = await llm<{ reply: string }>({
    model: "claude-sonnet-4-6",
    maxTokens: 500,
    system: `당신은 ${store.name}의 콘텐츠/마케팅 담당이다. JSON만: {"reply"}. ` +
      "3문장 이내, 구어체. 확신 없는 수치 제시 금지. 범위 밖이면 솔직히 모른다고 말한다.",
    prompt: `업종 ${store.industry}, 병목 ${opts.bottleneck}. 사장님 질문:\n"""${text.slice(0, 500)}"""`,
    validate: (o): o is { reply: string } => typeof o?.reply === "string",
  });
  return { category, reply: ans.reply };
}

// ── 3. 미사용 에피소드 조회 (콘텐츠 생성기의 sourceEpisodeIds 연결) ──

export async function pendingEpisodes(storeId: string, stage?: Stage) {
  const events = await readEvents({ storeId, types: ["episode_extracted", "content_generated"] });
  const used = new Set(events.filter((e) => e.type === "content_generated")
    .flatMap((e: any) => e.sourceEpisodeIds as string[]));
  return events
    .filter((e): e is EpisodeExtractedEvent => e.type === "episode_extracted")
    .filter((e) => !used.has(e.episodeId) && (!stage || e.stageRelevance === stage))
    .map(({ episodeId, stageRelevance, summary, at }) => ({ episodeId, stageRelevance, summary, at }));
}

// ── 원문 저장 (C등급, 파기 추적 등록) ────────────────────────

let chatGrantRegistered = new Set<string>();
async function storeChatText(storeId: string, text: string): Promise<string> {
  const loc = path.join(CHAT_STORE_DIR, storeId);
  await mkdir(loc, { recursive: true });
  const file = path.join(loc, `${Date.now()}-${randomUUID().slice(0, 6)}.txt`);
  await writeFile(file, text, "utf-8");
  if (!chatGrantRegistered.has(storeId)) {
    await grantAccess({ storeId, type: "owner_chat", storageLocation: loc });
    chatGrantRegistered.add(storeId);
  }
  return file;
}
