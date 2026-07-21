"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";

/* A looping, choreographed demo of what 0xTools does to an editor:
   phase 0 — SCAN: the contract's lines stream in
   phase 1 — ANNOTATE: inline gas chips pop onto the functions
   phase 2 — DECODE: the selector hover-card decodes withdraw(uint256) */

const SPRING = { type: "spring", stiffness: 420, damping: 22 } as const;

function Strip({
  className,
  stroke = "currentColor",
}: {
  className?: string;
  stroke?: string;
}) {
  const cells = [2.65, 7.75, 12.85, 17.95];
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      {cells.map((x, i) =>
        i === 1 ? (
          <rect key={x} x={x} y={6.5} width={3.4} height={11} rx={1.1} fill="#14C08A" />
        ) : (
          <rect
            key={x}
            x={x}
            y={6.5}
            width={3.4}
            height={11}
            rx={1.1}
            stroke={stroke}
            strokeWidth={1.7}
          />
        ),
      )}
    </svg>
  );
}

function GasChip({ on, tone, label }: { on: boolean; tone: "accent" | "amber"; label: string }) {
  const color =
    tone === "accent"
      ? "border-accent/40 bg-accent/10 text-accent"
      : "border-amber/40 bg-amber/10 text-amber";
  return (
    <motion.span
      initial={false}
      animate={on ? { opacity: 1, scale: 1, rotate: 0 } : { opacity: 0, scale: 0.4, rotate: -6 }}
      transition={SPRING}
      className={`ml-4 inline-block border px-1.5 text-[11px] ${color}`}
    >
      ⛽ {label}
    </motion.span>
  );
}

const STEPS = ["SCAN", "ANNOTATE", "DECODE"] as const;
const STATUS = [
  "$ 0xtools scan · parsing Vault.sol…",
  "⛽ gas estimated · 2 functions annotated",
  "selector 0x2e1a7d4d → withdraw(uint256) · 4byte ✓",
] as const;

const lineAnim = {
  hidden: { opacity: 0, x: -10 },
  show: { opacity: 1, x: 0, transition: { duration: 0.22 } },
};

export function EditorDemo() {
  const reduce = useReducedMotion();
  const [phase, setPhase] = useState(reduce ? 2 : 0);
  const [cycle, setCycle] = useState(0);

  useEffect(() => {
    if (reduce) return;
    const timers = [
      setTimeout(() => setPhase(1), 2200),
      setTimeout(() => setPhase(2), 4200),
      setTimeout(() => {
        setPhase(0);
        setCycle((c) => c + 1);
      }, 8200),
    ];
    return () => timers.forEach(clearTimeout);
  }, [cycle, reduce]);

  const L = ({ n, children }: { n: number; children: React.ReactNode }) => (
    <motion.span variants={lineAnim} className="block">
      <span className="mr-4 inline-block w-4 select-none text-right text-muted/50">{n}</span>
      {children}
    </motion.span>
  );

  return (
    <div className="relative">
      {/* step pills — which part of the pipeline is running */}
      <div className="mb-4 flex items-center gap-2 font-mono text-[11px]">
        {STEPS.map((s, i) => (
          <span key={s} className="flex items-center gap-2">
            <motion.span
              animate={{
                backgroundColor: phase === i ? "#14c08a" : "rgba(20,192,138,0)",
                color: phase === i ? "#0b0e11" : "#8a8f96",
              }}
              transition={{ duration: 0.25 }}
              className="border-2 border-edge px-2 py-0.5 font-semibold"
            >
              0{i + 1} {s}
            </motion.span>
            {i < STEPS.length - 1 && <span className="text-muted">→</span>}
          </span>
        ))}
      </div>

      <div className="border-2 border-edge bg-panel shadow-brut-lg">
        {/* title bar */}
        <div className="flex items-center justify-between border-b-2 border-ink bg-dark px-4 py-2.5">
          <div className="flex items-center gap-2">
            <span className="h-3 w-3 rounded-full border border-paper/30 bg-[#ff5f57]" />
            <span className="h-3 w-3 rounded-full border border-paper/30 bg-amber" />
            <span className="h-3 w-3 rounded-full border border-paper/30 bg-accent" />
          </div>
          <span className="font-mono text-xs text-muted">Vault.sol — VS Code</span>
          <Strip className="h-5 w-5" stroke="#F4F4F1" />
        </div>

        {/* code — lines stream in each cycle */}
        <motion.pre
          key={cycle}
          variants={{ show: { transition: { staggerChildren: 0.12 } }, hidden: {} }}
          initial={reduce ? "show" : "hidden"}
          animate="show"
          className="overflow-x-auto p-5 font-mono text-[13px] leading-7 text-paper/90"
        >
          <code>
            <L n={1}>
              <span className="text-muted">{"// SPDX-License-Identifier: MIT"}</span>
            </L>
            <L n={2}>
              <span className="text-blue">pragma</span> solidity ^0.8.24;
            </L>
            <L n={3}> </L>
            <L n={4}>
              <span className="text-blue">contract</span>{" "}
              <span className="text-amber">Vault</span> {"{"}
            </L>
            <L n={5}>
              {"  "}
              <span className="text-blue">mapping</span>(address {"=>"} uint256){" "}
              <span className="text-blue">public</span> balances;
            </L>
            <L n={6}> </L>
            <L n={7}>
              {"  "}
              <span className="text-blue">function</span>{" "}
              <span className="text-accent">deposit</span>(){" "}
              <span className="text-blue">external payable</span> {"{"}
              <GasChip on={phase >= 1} tone="accent" label="43,674 gas" />
            </L>
            <L n={8}>{"    balances[msg.sender] += msg.value;"}</L>
            <L n={9}>{"  }"}</L>
            <L n={10}> </L>
            <L n={11}>
              {"  "}
              <span className="text-blue">function</span>{" "}
              <motion.span
                animate={{
                  backgroundColor: phase >= 2 ? "rgba(20,192,138,0.16)" : "rgba(20,192,138,0)",
                  boxShadow:
                    phase >= 2 ? "0 0 0 1px rgba(20,192,138,0.6)" : "0 0 0 0 rgba(20,192,138,0)",
                }}
                className="text-accent"
              >
                withdraw
              </motion.span>
              (uint256) <span className="text-blue">external</span> {"{"}
              <GasChip on={phase >= 1} tone="amber" label="30,421 gas" />
            </L>
            <L n={12}>
              {"    "}...<span className="animate-blink text-paper">▌</span>
            </L>
          </code>
        </motion.pre>

        {/* status bar — narrates the current phase */}
        <div className="flex items-center gap-3 border-t border-ink bg-dark px-4 py-2 font-mono text-[11px]">
          <Strip className="h-3.5 w-3.5" stroke="#F4F4F1" />
          <AnimatePresence mode="wait">
            <motion.span
              key={phase}
              initial={{ opacity: 0, y: 5 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -5 }}
              transition={{ duration: 0.2 }}
              className={phase === 2 ? "text-accent" : "text-muted"}
            >
              {STATUS[phase]}
            </motion.span>
          </AnimatePresence>
        </div>
      </div>

      {/* decoded-selector hover card */}
      <AnimatePresence>
        {phase >= 2 && (
          <motion.div
            initial={{ opacity: 0, scale: 0.6, rotate: 10, y: 14 }}
            animate={{ opacity: 1, scale: 1, rotate: 2, y: 0 }}
            exit={{ opacity: 0, scale: 0.8, y: 8, transition: { duration: 0.18 } }}
            transition={SPRING}
            className="absolute -bottom-7 -right-3 border-2 border-ink bg-paper px-4 py-3 font-mono text-xs text-ink shadow-brut sm:-right-6"
          >
            <motion.div
              animate={reduce ? {} : { y: [0, -5, 0] }}
              transition={{ repeat: Infinity, duration: 3, ease: "easeInOut" }}
            >
              <div className="mb-1 flex items-center gap-2">
                <Strip className="h-4 w-4" />
                <span className="font-semibold">withdraw(uint256)</span>
              </div>
              <div className="text-muted">
                selector <span className="text-accent-deep">0x2e1a7d4d</span> · 4byte ✓
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
