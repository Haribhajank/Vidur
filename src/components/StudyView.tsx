"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { z } from "zod";
import { requestJson } from "@/lib/apiClient";
import { parseSseChunk } from "@/lib/gradioSse";
import {
  ApiErrorSchema,
  CitationSchema,
  FeynmanEvaluationSchema,
  safeJsonParse,
  StudyOverviewSchema,
  type Citation,
  type FeynmanEvaluation,
  type RatingValue,
  type StudyCard,
  type StudyConcept,
  type StudyOverview,
} from "@/types/schema";

type Tab = "path" | "cards" | "tutor";

const BLOOM_TONE: Record<string, string> = {
  remember: "bg-slate-100 text-slate-700",
  understand: "bg-sky-100 text-sky-800",
  apply: "bg-emerald-100 text-emerald-800",
  analyze: "bg-amber-100 text-amber-800",
  evaluate: "bg-violet-100 text-violet-800",
  create: "bg-rose-100 text-rose-800",
};

function pages(c: Citation): string {
  if (c.pageStart === null) return "";
  return c.pageEnd !== null && c.pageEnd !== c.pageStart ? `pp. ${c.pageStart}–${c.pageEnd}` : `p. ${c.pageStart}`;
}

function formatDue(iso: string): string {
  const ms = Date.parse(iso) - Date.now();
  if (ms <= 0) return "now";
  const hours = ms / 3_600_000;
  if (hours < 1) return `in ${Math.max(1, Math.round(ms / 60_000))} min`;
  if (hours < 24) return `in ${Math.round(hours)} h`;
  return `in ${Math.round(hours / 24)} days`;
}

// ---------------------------------------------------------------------------
// Feynman: explain a concept in your own words, get graded against the book
// ---------------------------------------------------------------------------

const FeynmanResponseSchema = z.object({ evaluation: FeynmanEvaluationSchema, citations: z.array(CitationSchema) });

function ScoreBar({ label, score }: { label: string; score: number }) {
  const tone = score >= 80 ? "bg-emerald-500" : score >= 50 ? "bg-amber-500" : "bg-rose-500";
  return (
    <div>
      <div className="flex justify-between text-xs text-slate-600">
        <span>{label}</span>
        <span className="tabular-nums">{score}/100</span>
      </div>
      <div className="mt-1 h-2 rounded-full bg-slate-200">
        <div className={`h-2 rounded-full ${tone}`} style={{ width: `${score}%` }} />
      </div>
    </div>
  );
}

function FeynmanPanel({ concept }: { concept: StudyConcept }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ evaluation: FeynmanEvaluation; citations: Citation[] } | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const response = await requestJson("/api/feynman", FeynmanResponseSchema, {
      method: "POST",
      body: JSON.stringify({ conceptId: concept.id, explanation: text }),
    });
    setBusy(false);
    if (response.ok) setResult(response.data);
    else setError(response.message);
  }

  return (
    <div className="mt-3 space-y-3 rounded-xl bg-slate-50 p-4">
      <form onSubmit={(e) => void submit(e)} className="space-y-2">
        <label className="block text-sm font-medium text-slate-800">
          Explain “{concept.title}” in your own words, as if teaching a friend:
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={4}
            minLength={20}
            maxLength={8000}
            required
            className="mt-1 w-full rounded-lg border border-slate-300 bg-white p-2 text-sm font-normal focus:border-indigo-500 focus:outline-none"
          />
        </label>
        <button
          type="submit"
          disabled={busy || text.trim().length < 20}
          className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {busy ? "Grading against the book…" : "Check my explanation"}
        </button>
        {text.trim().length > 0 && text.trim().length < 20 ? <span className="ml-2 text-xs text-slate-500">At least 20 characters</span> : null}
      </form>
      {error !== null ? <p role="alert" className="text-sm text-rose-700">{error}</p> : null}
      {result !== null ? (
        <div className="space-y-3 border-t border-slate-200 pt-3 text-sm">
          <div className="grid gap-2 sm:grid-cols-3">
            <ScoreBar label="Overall" score={result.evaluation.overallScore} />
            <ScoreBar label="Accuracy" score={result.evaluation.accuracy.score} />
            <ScoreBar label="Coverage" score={result.evaluation.coverage.score} />
          </div>
          <p className="text-slate-700">{result.evaluation.accuracy.rationale}</p>
          {result.evaluation.misconceptions.length > 0 ? (
            <div>
              <p className="font-semibold text-rose-800">Misconceptions</p>
              <ul className="mt-1 list-disc space-y-1 pl-5 text-slate-700">
                {result.evaluation.misconceptions.map((m) => (
                  <li key={m.studentClaim}>
                    <span className="italic">“{m.studentClaim}”</span> → {m.correction}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {result.evaluation.missingNuances.length > 0 ? (
            <div>
              <p className="font-semibold text-amber-800">What you missed</p>
              <ul className="mt-1 list-disc space-y-1 pl-5 text-slate-700">
                {result.evaluation.missingNuances.map((n) => (
                  <li key={n.point}>
                    {n.point} <span className="text-slate-500">— {n.whyItMatters}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <p className="rounded-lg bg-indigo-50 px-3 py-2 text-indigo-900">
            <span className="font-semibold">Try next:</span> {result.evaluation.suggestedFollowUpQuestion}
          </p>
          {result.citations.length > 0 ? (
            <p className="text-xs text-slate-500">Graded against: {result.citations.map(pages).filter(Boolean).join(", ") || "book excerpts"}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Learning path
// ---------------------------------------------------------------------------

function LearningPath({ concepts, onAsk }: { concepts: StudyConcept[]; onAsk: (c: StudyConcept) => void }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const titles = new Map(concepts.map((c) => [c.id, c.title]));
  return (
    <ol className="space-y-2">
      {concepts.map((concept, index) => (
        <li key={concept.id} className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-900 text-xs font-semibold text-white">
              {index + 1}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-semibold text-slate-900">{concept.title}</h3>
                {concept.bloomLevel !== null ? (
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${BLOOM_TONE[concept.bloomLevel]}`}>{concept.bloomLevel}</span>
                ) : null}
              </div>
              {concept.description !== null ? <p className="mt-1 text-sm text-slate-600">{concept.description}</p> : null}
              {concept.prerequisiteIds.length > 0 ? (
                <p className="mt-1 text-xs text-slate-500">
                  Builds on: {concept.prerequisiteIds.map((id) => titles.get(id)).filter(Boolean).join(", ")}
                </p>
              ) : null}
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setOpenId(openId === concept.id ? null : concept.id)}
                  className="rounded-lg border border-indigo-200 px-3 py-1.5 text-xs font-semibold text-indigo-700 hover:bg-indigo-50"
                >
                  {openId === concept.id ? "Hide" : "Explain it back"}
                </button>
                <button
                  type="button"
                  onClick={() => onAsk(concept)}
                  className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                >
                  Ask the tutor
                </button>
              </div>
              {openId === concept.id ? <FeynmanPanel concept={concept} /> : null}
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}

// ---------------------------------------------------------------------------
// Flashcards (FSRS)
// ---------------------------------------------------------------------------

const ReviewResponseSchema = z.object({ cardId: z.uuid(), dueDate: z.string() });
const RATINGS: { value: RatingValue; label: string; tone: string }[] = [
  { value: 1, label: "Again", tone: "bg-rose-600 hover:bg-rose-500" },
  { value: 2, label: "Hard", tone: "bg-amber-600 hover:bg-amber-500" },
  { value: 3, label: "Good", tone: "bg-emerald-600 hover:bg-emerald-500" },
  { value: 4, label: "Easy", tone: "bg-sky-600 hover:bg-sky-500" },
];

function Flashcards({
  cards,
  concepts,
  nextDueDate,
  onFinished,
}: {
  cards: StudyCard[];
  concepts: StudyConcept[];
  nextDueDate: string | null;
  onFinished: () => void;
}) {
  const [queue, setQueue] = useState(cards);
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(0);
  const titles = new Map(concepts.map((c) => [c.id, c.title]));
  const card = queue[0];

  async function rate(rating: RatingValue) {
    if (card === undefined) return;
    setBusy(true);
    setError(null);
    const result = await requestJson(`/api/cards/${card.id}/review`, ReviewResponseSchema, {
      method: "POST",
      body: JSON.stringify({ rating }),
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setDone((n) => n + 1);
    setRevealed(false);
    // "Again" cards come back within minutes; show them again at the end of this session.
    const rest = queue.slice(1);
    setQueue(Date.parse(result.data.dueDate) - Date.now() < 10 * 60_000 ? [...rest, card] : rest);
    if (rest.length === 0 && rating !== 1) onFinished();
  }

  if (card === undefined) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-8 text-center">
        <p className="text-lg font-semibold text-slate-900">{done > 0 ? `Nice — ${done} reviews done.` : "No cards due right now."}</p>
        <p className="mt-1 text-sm text-slate-600">
          {nextDueDate !== null ? `Next card is due ${formatDue(nextDueDate)}.` : "Cards appear here once the curriculum is ready."}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-500">
        {queue.length} left · {titles.get(card.conceptId) ?? "Concept"}
      </p>
      <div className="min-h-48 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <p className="whitespace-pre-wrap text-lg text-slate-900">{card.front}</p>
        {revealed ? <p className="mt-4 whitespace-pre-wrap border-t border-slate-200 pt-4 text-slate-700">{card.back}</p> : null}
      </div>
      {error !== null ? <p role="alert" className="text-sm text-rose-700">{error}</p> : null}
      {revealed ? (
        <div className="grid grid-cols-4 gap-2">
          {RATINGS.map((r) => (
            <button
              key={r.value}
              type="button"
              disabled={busy}
              onClick={() => void rate(r.value)}
              className={`rounded-xl px-3 py-2 text-sm font-semibold text-white disabled:opacity-50 ${r.tone}`}
            >
              {r.label}
            </button>
          ))}
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setRevealed(true)}
          className="w-full rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700"
        >
          Show answer
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Socratic tutor (SSE stream)
// ---------------------------------------------------------------------------

interface Message {
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly citations?: readonly Citation[];
  readonly error?: string;
}

const CitationsEventSchema = z.object({ citations: z.array(CitationSchema) });
const TextEventSchema = z.object({ delta: z.string() });
const ErrorEventSchema = z.object({ message: z.string() });

function Tutor({ bookId, focus, onClearFocus }: { bookId: string; focus: StudyConcept | null; onClearFocus: () => void }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (focus !== null && messages.length === 0) setInput(`Help me understand “${focus.title}”.`);
  }, [focus, messages.length]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  const updateLast = (fn: (m: Message) => Message) =>
    setMessages((prev) => [...prev.slice(0, -1), fn(prev[prev.length - 1] as Message)]);

  async function send(event: FormEvent) {
    event.preventDefault();
    const message = input.trim();
    if (message.length === 0 || streaming) return;
    const history = messages.filter((m) => m.error === undefined && m.content.length > 0).map(({ role, content }) => ({ role, content }));
    setInput("");
    setStreaming(true);
    setMessages((prev) => [...prev, { role: "user", content: message }, { role: "assistant", content: "" }]);

    try {
      const response = await fetch("/api/tutor/stream", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bookId, message, history: history.slice(-40), ...(focus !== null ? { conceptId: focus.id } : {}) }),
      });
      if (!response.ok || response.body === null) {
        const parsed = safeJsonParse(await response.text(), ApiErrorSchema);
        updateLast((m) => ({ ...m, error: parsed.ok ? parsed.data.error.message : `Request failed (${response.status})` }));
        return;
      }
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const parsed = parseSseChunk(buffer + value);
        buffer = parsed.rest;
        for (const ev of parsed.events) {
          if (ev.event === "text") {
            const data = safeJsonParse(ev.data, TextEventSchema);
            if (data.ok) updateLast((m) => ({ ...m, content: m.content + data.data.delta }));
          } else if (ev.event === "citations") {
            const data = safeJsonParse(ev.data, CitationsEventSchema);
            if (data.ok) updateLast((m) => ({ ...m, citations: data.data.citations }));
          } else if (ev.event === "error") {
            const data = safeJsonParse(ev.data, ErrorEventSchema);
            updateLast((m) => ({ ...m, error: data.ok ? data.data.message : "The tutor hit an error." }));
          }
        }
      }
    } catch {
      updateLast((m) => ({ ...m, error: "Connection lost. Try again." }));
    } finally {
      setStreaming(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {focus !== null ? (
        <p className="flex items-center gap-2 text-xs text-slate-600">
          Focused on <span className="rounded-full bg-indigo-100 px-2 py-0.5 font-medium text-indigo-800">{focus.title}</span>
          <button type="button" onClick={onClearFocus} className="text-slate-500 underline">
            clear
          </button>
        </p>
      ) : null}
      <div className="max-h-[60vh] min-h-48 space-y-3 overflow-y-auto rounded-2xl border border-slate-200 bg-white p-4">
        {messages.length === 0 ? (
          <p className="text-sm text-slate-500">
            Ask anything about this book. The tutor answers from the book itself and will often answer with a guiding question — that’s on purpose.
          </p>
        ) : null}
        {messages.map((m, i) => (
          <div key={i} className={m.role === "user" ? "flex justify-end" : ""}>
            <div className={`max-w-[85%] rounded-2xl px-4 py-2 text-sm ${m.role === "user" ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-900"}`}>
              <p className="whitespace-pre-wrap">{m.content || (streaming && i === messages.length - 1 && m.error === undefined ? "…" : "")}</p>
              {m.error !== undefined ? <p className="mt-1 text-rose-700">{m.error}</p> : null}
              {m.citations !== undefined && m.citations.length > 0 ? (
                <details className="mt-2 text-xs text-slate-600">
                  <summary className="cursor-pointer">Sources ({m.citations.map(pages).filter(Boolean).join(", ") || `${m.citations.length} excerpts`})</summary>
                  <ul className="mt-1 space-y-1">
                    {m.citations.map((c) => (
                      <li key={c.chunkId} className="rounded bg-white p-2">
                        {pages(c) ? <span className="font-medium">{pages(c)}: </span> : null}
                        {c.rawSnippet}
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
      <form onSubmit={(e) => void send(e)} className="flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          maxLength={4000}
          placeholder="Ask the tutor…"
          className="min-w-0 flex-1 rounded-xl border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
        />
        <button
          type="submit"
          disabled={streaming || input.trim().length === 0}
          className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {streaming ? "Thinking…" : "Send"}
        </button>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Study view
// ---------------------------------------------------------------------------

export default function StudyView({ bookId, onBack }: { bookId: string; onBack: () => void }) {
  const [data, setData] = useState<StudyOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("path");
  const [focus, setFocus] = useState<StudyConcept | null>(null);

  const load = useCallback(async () => {
    const result = await requestJson(`/api/books/${bookId}/study`, StudyOverviewSchema, { method: "GET" });
    if (result.ok) {
      setData(result.data);
      setError(null);
    } else {
      setError(result.message);
    }
  }, [bookId]);

  useEffect(() => {
    void load();
  }, [load]);

  const building = data !== null && (data.book.graphStatus === "pending" || data.book.graphStatus === "generating");
  useEffect(() => {
    if (!building) return;
    const timer = setInterval(() => void load(), 8000);
    return () => clearInterval(timer);
  }, [building, load]);

  const tabs: { id: Tab; label: string }[] = [
    { id: "path", label: `Learning path${data ? ` (${data.concepts.length})` : ""}` },
    { id: "cards", label: `Flashcards${data ? ` (${data.dueCards.length} due)` : ""}` },
    { id: "tutor", label: "Ask the tutor" },
  ];

  return (
    <section className="space-y-5">
      <div>
        <button type="button" onClick={onBack} className="text-sm font-medium text-indigo-700 hover:underline">
          ← Library
        </button>
        <h2 className="mt-1 text-xl font-semibold text-slate-900">{data?.book.title ?? "Loading…"}</h2>
        {data !== null ? (
          <p className="text-sm text-slate-600">
            {data.book.author ?? "Unknown author"} · {data.concepts.length} concepts · {data.totalCards} flashcards
          </p>
        ) : null}
      </div>

      {error !== null ? <p role="alert" className="text-sm text-rose-700">{error}</p> : null}
      {building ? (
        <p role="status" className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
          Building your curriculum from the book… this takes a minute or two. The tutor already works.
        </p>
      ) : null}
      {data?.book.graphStatus === "failed" ? (
        <p role="status" className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800">
          Curriculum generation failed for this book. The tutor still works.
        </p>
      ) : null}

      <div role="tablist" className="flex flex-wrap gap-2 border-b border-slate-200">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            type="button"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${
              tab === t.id ? "border-indigo-600 text-indigo-700" : "border-transparent text-slate-600 hover:text-slate-900"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {data === null ? (
        <div className="h-40 animate-pulse rounded-2xl bg-slate-100" aria-busy="true" />
      ) : tab === "path" ? (
        data.concepts.length === 0 ? (
          <p className="text-sm text-slate-500">No concepts yet.</p>
        ) : (
          <LearningPath
            concepts={data.concepts}
            onAsk={(c) => {
              setFocus(c);
              setTab("tutor");
            }}
          />
        )
      ) : tab === "cards" ? (
        <Flashcards
          cards={data.dueCards}
          concepts={data.concepts}
          nextDueDate={data.nextDueDate}
          onFinished={() => void load()}
        />
      ) : (
        <Tutor bookId={bookId} focus={focus} onClearFocus={() => setFocus(null)} />
      )}
    </section>
  );
}
