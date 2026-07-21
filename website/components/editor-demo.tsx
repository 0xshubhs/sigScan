"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";

/* The hero editor. Code is always fully visible — the only motion is a calm
   focus loop: the "hovered" function alternates between deposit() and
   withdraw(), and the decode card + status bar follow it. */

const FNS = [
  {
    name: "deposit()",
    selector: "0xd0e30db0",
  },
  {
    name: "withdraw(uint256)",
    selector: "0x2e1a7d4d",
  },
] as const;

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

function FnName({ active, children }: { active: boolean; children: React.ReactNode }) {
  return (
    <motion.span
      initial={false}
      animate={{
        backgroundColor: active ? "rgba(20,192,138,0.14)" : "rgba(20,192,138,0)",
        boxShadow: active
          ? "0 0 0 1px rgba(20,192,138,0.55)"
          : "0 0 0 0 rgba(20,192,138,0)",
      }}
      transition={{ duration: 0.45 }}
      className="text-accent"
    >
      {children}
    </motion.span>
  );
}

export function EditorDemo() {
  const reduce = useReducedMotion();
  const [focus, setFocus] = useState(1);

  useEffect(() => {
    if (reduce) return;
    const t = setInterval(() => setFocus((f) => (f + 1) % 2), 4500);
    return () => clearInterval(t);
  }, [reduce]);

  const fn = FNS[focus];

  const Line = ({ n, children }: { n: number; children: React.ReactNode }) => (
    <span className="block">
      <span className="mr-4 inline-block w-4 select-none text-right text-muted/50">{n}</span>
      {children}
    </span>
  );

  return (
    <div className="relative">
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

        {/* code */}
        <pre className="overflow-x-auto p-5 font-mono text-[13px] leading-7 text-paper/90">
          <code>
            <Line n={1}>
              <span className="text-muted">{"// SPDX-License-Identifier: MIT"}</span>
            </Line>
            <Line n={2}>
              <span className="text-blue">pragma</span> solidity ^0.8.24;
            </Line>
            <Line n={3}> </Line>
            <Line n={4}>
              <span className="text-blue">contract</span>{" "}
              <span className="text-amber">Vault</span> {"{"}
            </Line>
            <Line n={5}>
              {"  "}
              <span className="text-blue">mapping</span>(address {"=>"} uint256){" "}
              <span className="text-blue">public</span> balances;
            </Line>
            <Line n={6}> </Line>
            <Line n={7}>
              {"  "}
              <span className="text-blue">function</span>{" "}
              <FnName active={focus === 0}>deposit</FnName>(){" "}
              <span className="text-blue">external payable</span> {"{"}
              <span className="ml-4 border border-accent/40 bg-accent/10 px-1.5 text-[11px] text-accent">
                ⛽ 43,674 gas
              </span>
            </Line>
            <Line n={8}>{"    balances[msg.sender] += msg.value;"}</Line>
            <Line n={9}>{"  }"}</Line>
            <Line n={10}> </Line>
            <Line n={11}>
              {"  "}
              <span className="text-blue">function</span>{" "}
              <FnName active={focus === 1}>withdraw</FnName>(uint256){" "}
              <span className="text-blue">external</span> {"{"}
              <span className="ml-4 border border-amber/40 bg-amber/10 px-1.5 text-[11px] text-amber">
                ⛽ 30,421 gas
              </span>
            </Line>
            <Line n={12}>
              {"    "}...<span className="animate-blink text-paper">▌</span>
            </Line>
          </code>
        </pre>

        {/* status bar */}
        <div className="flex items-center gap-3 overflow-hidden border-t border-ink bg-dark px-4 py-2 font-mono text-[11px]">
          <Strip className="h-3.5 w-3.5" stroke="#F4F4F1" />
          <AnimatePresence mode="wait" initial={false}>
            <motion.span
              key={fn.selector}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.25 }}
              className="text-muted"
            >
              selector <span className="text-accent">{fn.selector}</span> → {fn.name} ·
              4byte ✓
            </motion.span>
          </AnimatePresence>
        </div>
      </div>

      {/* decode card — anchored, content follows the focused function */}
      <div className="absolute -bottom-7 -right-3 rotate-[2deg] border-2 border-ink bg-paper px-4 py-3 font-mono text-xs text-ink shadow-brut sm:-right-6">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={fn.selector}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.25 }}
          >
            <div className="mb-1 flex items-center gap-2">
              <Strip className="h-4 w-4" />
              <span className="font-semibold">{fn.name}</span>
            </div>
            <div className="text-muted">
              selector <span className="text-accent-deep">{fn.selector}</span> · 4byte ✓
            </div>
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
