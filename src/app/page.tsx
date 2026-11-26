"use client";

import React, { useEffect, useRef, useState } from "react";
import { RotateCcw, Send, Sparkles } from "lucide-react";
import { sendChatMessage } from "@/lib/api";

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  error?: boolean;
}

const STARTER_PROMPTS = [
  {
    title: "Ringkasan APBD Surabaya",
    prompt:
      "Berapa total alokasi anggaran, realisasi SP2D, dan persentase serapan APBD Surabaya saat ini?",
  },
  {
    title: "5 Dinas Anggaran Terbesar",
    prompt:
      "Sebutkan 5 dinas dengan anggaran terbesar beserta jumlah SP2D dan persentase serapannya.",
  },
  {
    title: "Dinas Serapan Rendah",
    prompt:
      "Dinas mana saja yang serapannya masih di bawah 50%? Urutkan dari yang paling rendah.",
  },
  {
    title: "Prioritas Stunting & Pendidikan",
    prompt:
      "Bagaimana sebaran anggaran tematik prioritas (Pendidikan, Kemiskinan, Stunting, Infrastruktur) di eBudgeting?",
  },
];

/** Lightweight safe formatter for assistant markdown (bold, inline code, bullet lists, tables). */
function MessageBody({ text }: { text: string }) {
  const lines = text.split("\n");
  const blocks: React.ReactNode[] = [];
  let i = 0;

  const renderInline = (line: string, keyPrefix: string) => {
    const parts = line.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
    return parts.map((part, idx) => {
      if (part.startsWith("**") && part.endsWith("**")) {
        return (
          <strong key={`${keyPrefix}-${idx}`} className="font-semibold text-[var(--text)]">
            {part.slice(2, -2)}
          </strong>
        );
      }
      if (part.startsWith("`") && part.endsWith("`")) {
        return (
          <code
            key={`${keyPrefix}-${idx}`}
            className="font-mono-code text-[12px] px-1 py-0.5 rounded bg-[var(--ground)] border border-[var(--border)]"
          >
            {part.slice(1, -1)}
          </code>
        );
      }
      return <React.Fragment key={`${keyPrefix}-${idx}`}>{part}</React.Fragment>;
    });
  };

  while (i < lines.length) {
    const line = lines[i].trimEnd();

    // Markdown table block
    if (line.trim().startsWith("|") && i + 1 < lines.length && lines[i + 1].includes("---")) {
      const headerCells = line
        .trim()
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((c) => c.trim());
      i += 2;
      const bodyRows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        bodyRows.push(
          lines[i]
            .trim()
            .replace(/^\||\|$/g, "")
            .split("|")
            .map((c) => c.trim())
        );
        i += 1;
      }
      blocks.push(
        <div
          key={`tbl-${i}`}
          className="overflow-x-auto my-2 border border-[var(--border)] rounded-md"
        >
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr className="bg-[var(--ground)] border-b border-[var(--border)]">
                {headerCells.map((h, hi) => (
                  <th key={hi} className="text-left font-medium px-3 py-2 text-[var(--muted)]">
                    {renderInline(h, `th-${i}-${hi}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {bodyRows.map((row, ri) => (
                <tr key={ri} className="border-b border-[var(--rule)] last:border-b-0">
                  {row.map((cell, ci) => (
                    <td key={ci} className="px-3 py-2 tabular-nums">
                      {renderInline(cell, `td-${i}-${ri}-${ci}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }

    // Bullet list
    if (/^[-*•]\s+/.test(line.trim())) {
      const items: string[] = [];
      while (i < lines.length && /^[-*•]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^[-*•]\s+/, ""));
        i += 1;
      }
      blocks.push(
        <ul key={`ul-${i}`} className="list-disc pl-5 my-1.5 space-y-1">
          {items.map((it, idx) => (
            <li key={idx}>{renderInline(it, `li-${i}-${idx}`)}</li>
          ))}
        </ul>
      );
      continue;
    }

    // Numbered list
    if (/^\d+\.\s+/.test(line.trim())) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^\d+\.\s+/, ""));
        i += 1;
      }
      blocks.push(
        <ol key={`ol-${i}`} className="list-decimal pl-5 my-1.5 space-y-1">
          {items.map((it, idx) => (
            <li key={idx}>{renderInline(it, `oli-${i}-${idx}`)}</li>
          ))}
        </ol>
      );
      continue;
    }

    // Heading
    if (/^#{1,3}\s+/.test(line.trim())) {
      blocks.push(
        <div key={`h-${i}`} className="font-semibold text-[15px] text-[var(--text)] mt-2.5 mb-1">
          {renderInline(line.trim().replace(/^#{1,3}\s+/, ""), `hd-${i}`)}
        </div>
      );
      i += 1;
      continue;
    }

    if (!line.trim()) {
      i += 1;
      continue;
    }

    blocks.push(
      <p key={`p-${i}`} className="my-1 leading-relaxed">
        {renderInline(line, `p-${i}`)}
      </p>
    );
    i += 1;
  }

  return <div className="text-[14px] text-[var(--text)]">{blocks}</div>;
}

export default function ChatbotHomePage() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, sending]);

  const handleSend = async (customText?: string) => {
    const text = (customText ?? input).trim();
    if (!text || sending) return;

    const userMsg: ChatMessage = {
      id: `u-${Date.now()}`,
      role: "user",
      content: text,
    };
    const nextHistory = messages.map((m) => ({ role: m.role, content: m.content }));
    setMessages((prev) => [...prev, userMsg]);
    if (!customText) setInput("");
    setSending(true);

    try {
      const res = await sendChatMessage(text, nextHistory);
      setMessages((prev) => [
        ...prev,
        {
          id: `a-${Date.now()}`,
          role: "assistant",
          content: res.answer,
        },
      ]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          id: `e-${Date.now()}`,
          role: "assistant",
          content:
            err instanceof Error
              ? err.message
              : "Gagal menghubungi server chatbot. Silakan coba lagi.",
          error: true,
        },
      ]);
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="min-h-[100svh] flex flex-col bg-[var(--ground)]">
      {/* Top navigation bar */}
      <header className="h-12 px-4 md:px-6 flex items-center justify-between gap-3 bg-[var(--ground)] border-b border-[var(--border)] sticky top-0 z-20">
        <div className="flex items-center gap-2.5">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M12 3L3 7.5L12 12L21 7.5L12 3Z"
              stroke="#166553"
              strokeWidth="1.8"
              strokeLinejoin="round"
            />
            <path
              d="M3 12L12 16.5L21 12"
              stroke="#166553"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M3 16.5L12 21L21 16.5"
              stroke="#166553"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span className="text-[14px] font-semibold tracking-[-0.01em]">SuraLake AI</span>
        </div>

        <div className="flex items-center gap-2">
          {messages.length > 0 && (
            <button
              type="button"
              onClick={() => setMessages([])}
              className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-md border border-[var(--control)] bg-white text-[13px] font-medium text-[var(--text)] hover:bg-[var(--raised)] cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Chat Baru</span>
            </button>
          )}
        </div>
      </header>

      {/* Main chat canvas */}
      <main className="flex-1 flex flex-col w-full max-w-[900px] mx-auto px-4 py-6">
        {messages.length === 0 ? (
          <div className="my-auto flex flex-col gap-6 py-4">
            <div className="flex flex-col gap-2">
              <div className="inline-flex items-center gap-1.5 text-[12px] font-medium text-[var(--accent)] w-fit">
                <Sparkles className="w-3.5 h-3.5" />
                <span>Asisten Anggaran Pemerintah Kota Surabaya</span>
              </div>
              <h1 className="text-[24px] leading-8 font-semibold tracking-[-0.015em] text-[var(--text)]">
                Tanya Data APBD Surabaya dengan Bahasa Sehari-hari
              </h1>
            </div>

            {/* Starter prompt cards */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {STARTER_PROMPTS.map((item) => (
                <button
                  key={item.title}
                  type="button"
                  onClick={() => handleSend(item.prompt)}
                  disabled={sending}
                  className="text-left bg-white border border-[var(--border)] rounded-lg p-4 hover:border-[var(--accent)] hover:bg-[#fafcfb] transition-colors cursor-pointer flex flex-col gap-1"
                >
                  <span className="text-[13px] font-semibold text-[var(--text)]">
                    {item.title}
                  </span>
                  <span className="text-[13px] text-[var(--muted)] leading-snug">
                    {item.prompt}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="flex-1 flex flex-col gap-4 pb-6">
            {messages.map((m) => (
              <div
                key={m.id}
                className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
              >
                {m.role === "user" ? (
                  <div className="max-w-[82%] bg-[var(--primary)] text-[var(--primary-ink)] rounded-2xl rounded-br-sm px-4 py-2.5 text-[14px] leading-relaxed">
                    {m.content}
                  </div>
                ) : (
                  <div
                    className={`w-full max-w-[92%] bg-white border rounded-2xl rounded-bl-sm px-4 py-3.5 ${
                      m.error
                        ? "border-[#f5c2c0] bg-[var(--pill-negative-bg)]"
                        : "border-[var(--border)]"
                    }`}
                  >
                    <MessageBody text={m.content} />
                  </div>
                )}
              </div>
            ))}

            {sending && (
              <div className="flex justify-start">
                <div className="bg-white border border-[var(--border)] rounded-2xl rounded-bl-sm px-4 py-3 text-[13px] text-[var(--muted)] flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-[var(--accent)] animate-pulse" />
                  <span>Sedang mencari dan menghitung data APBD...</span>
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>
        )}
      </main>

      {/* Bottom sticky composer */}
      <footer className="sticky bottom-0 bg-[var(--ground)] border-t border-[var(--border)] px-4 py-3">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleSend();
          }}
          className="w-full max-w-[900px] mx-auto flex items-end gap-2 bg-white border border-[var(--control)] rounded-xl p-2 focus-within:border-[var(--accent)]"
        >
          <textarea
            rows={1}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            disabled={sending}
            placeholder="Tanyakan soal APBD Surabaya, serapan dinas, atau anomali data..."
            className="flex-1 resize-none border-0 bg-transparent px-2 py-1.5 text-[14px] text-[var(--text)] placeholder:text-[var(--faint)] focus:outline-none max-h-32"
          />
          <button
            type="submit"
            disabled={sending || !input.trim()}
            aria-label="Kirim pesan"
            className="h-9 px-3.5 rounded-lg bg-[var(--primary)] text-[var(--primary-ink)] text-[13px] font-medium inline-flex items-center gap-1.5 hover:bg-[#2a2d30] disabled:opacity-40 cursor-pointer shrink-0"
          >
            <Send className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Kirim</span>
          </button>
        </form>
        <div className="w-full max-w-[900px] mx-auto mt-1.5 text-[11px] text-[var(--faint)] px-1">
          <span>Enter untuk kirim · Shift+Enter baris baru</span>
        </div>
      </footer>
    </div>
  );
}
