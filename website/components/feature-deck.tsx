"use client";

import { useEffect, useState } from "react";
import { motion, useReducedMotion } from "motion/react";

/* Hero deck: five feature cards stacked back-to-back. The front card holds,
   then slides under the deck and the next one springs forward — each card is
   a small depiction of one thing 0xTools actually does. */

const HOLD_MS = 3200;
const SPRING = { type: "spring", stiffness: 260, damping: 26 } as const;

function Strip({ className, stroke = "#F4F4F1" }: { className?: string; stroke?: string }) {
  const cells = [2.65, 7.75, 12.85, 17.95];
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      {cells.map((x, i) =>
        i === 1 ? (
          <rect key={x} x={x} y={6.5} width={3.4} height={11} rx={1.1} fill="#14C08A" />
        ) : (
          <rect key={x} x={x} y={6.5} width={3.4} height={11} rx={1.1} stroke={stroke} strokeWidth={1.7} />
        ),
      )}
    </svg>
  );
}

function CardShell({
  tag,
  title,
  children,
}: {
  tag: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-full flex-col border-2 border-edge bg-panel text-paper shadow-brut-lg">
      <div className="flex items-center justify-between border-b-2 border-ink bg-dark px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full border border-paper/30 bg-[#ff5f57]" />
          <span className="h-2.5 w-2.5 rounded-full border border-paper/30 bg-amber" />
          <span className="h-2.5 w-2.5 rounded-full border border-paper/30 bg-accent" />
        </div>
        <span className="font-mono text-[11px] text-muted">{title}</span>
        <Strip className="h-4 w-4" />
      </div>
      <div className="border-b border-ink bg-dark/60 px-4 py-1.5">
        <span className="border border-accent/60 bg-accent/10 px-2 py-0.5 font-mono text-[10px] font-semibold tracking-widest text-accent">
          {tag}
        </span>
      </div>
      <div className="flex-1 overflow-hidden p-4 font-mono text-[12.5px] leading-6">
        {children}
      </div>
    </div>
  );
}

const CARDS = [
  {
    key: "deploy",
    node: (
      <CardShell tag="DEPLOY & RUN" title="terminal — anvil">
        <p className="text-muted">$ 0xtools: start anvil</p>
        <p className="text-paper/85">Listening on 127.0.0.1:8545</p>
        <p className="mt-2 text-muted">$ deploy Vault.sol</p>
        <p className="text-paper/85">
          ➜ Vault deployed <span className="text-blue">0x5FbD…0aa3</span>
        </p>
        <p className="text-accent">✓ 2 txs · block #3 · 0.0042 ETH gas</p>
        <p className="mt-2 text-muted">
          keystore: dev-wallet <span className="text-accent">unlocked ✓</span>
        </p>
      </CardShell>
    ),
  },
  {
    key: "gas",
    node: (
      <CardShell tag="INLINE GAS" title="Vault.sol — VS Code">
        <p>
          <span className="text-blue">function</span>{" "}
          <span className="text-accent">deposit</span>(){" "}
          <span className="text-blue">external payable</span> {"{"}
          <span className="ml-3 border border-accent/40 bg-accent/10 px-1.5 text-[10.5px] text-accent">
            ⛽ 43,674
          </span>
        </p>
        <p className="text-paper/70">{"  balances[msg.sender] += msg.value;"}</p>
        <p>{"}"}</p>
        <p className="mt-2">
          <span className="text-blue">function</span>{" "}
          <span className="text-accent">withdraw</span>(uint256) {"{"}
          <span className="ml-3 border border-amber/40 bg-amber/10 px-1.5 text-[10.5px] text-amber">
            ⛽ 30,421
          </span>
        </p>
        <p className="mt-2 text-muted">
          optimizer: <span className="text-accent">−2,110 gas</span> · use custom errors
        </p>
      </CardShell>
    ),
  },
  {
    key: "decode",
    node: (
      <CardShell tag="SELECTOR DECODE" title="hover — 0x2e1a7d4d">
        <p className="text-muted">unknown calldata</p>
        <p className="break-all text-paper/85">0x2e1a7d4d000000000000000000…0de0b6b3a7640000</p>
        <div className="mt-3 border-2 border-ink bg-paper px-3 py-2 text-ink">
          <p className="font-semibold">withdraw(uint256 wad)</p>
          <p className="text-[11px] text-ink/60">
            selector <span className="text-accent-deep">0x2e1a7d4d</span> · wad = 1.0 ETH ·
            4byte ✓
          </p>
        </div>
      </CardShell>
    ),
  },
  {
    key: "audit",
    node: (
      <CardShell tag="SECURITY AUDIT" title="25+ analysis modules">
        <p>
          <span className="text-amber">⚠ reentrancy</span>{" "}
          <span className="text-muted">withdraw() — L11 · external call before state write</span>
        </p>
        <p>
          <span className="text-amber">⚠ missing event</span>{" "}
          <span className="text-muted">balances written, none emitted</span>
        </p>
        <p>
          <span className="text-accent">✓ access control</span>{" "}
          <span className="text-muted">no unprotected selfdestruct</span>
        </p>
        <p>
          <span className="text-accent">✓ ERC-20 compliant</span>{" "}
          <span className="text-muted">interface check passed</span>
        </p>
        <p className="mt-2 text-muted">
          MEV: <span className="text-amber">sandwich risk</span> · slither: 0 high
        </p>
      </CardShell>
    ),
  },
  {
    key: "toolbox",
    node: (
      <CardShell tag="EVM TOOLBOX" title="command palette">
        <p className="text-muted">&gt; convert units</p>
        <p className="text-paper/85">
          1 ether = <span className="text-accent">10¹⁸ wei</span> · 21000 gwei = 0.000021 ETH
        </p>
        <p className="mt-2 text-muted">&gt; keccak-256</p>
        <p className="break-all text-paper/85">
          transfer(address,uint256) → <span className="text-accent">0xa9059cbb</span>
        </p>
        <p className="mt-2 text-muted">&gt; CREATE2 address</p>
        <p className="text-paper/85">
          salt 0x00…01 → <span className="text-blue">0x4f5B…9c21</span>
        </p>
      </CardShell>
    ),
  },
];

const N = CARDS.length;

export function FeatureDeck() {
  const reduce = useReducedMotion();
  const [front, setFront] = useState(0);
  const [dragging, setDragging] = useState(false);

  // auto-advance; the `front` dep restarts the hold timer after any manual
  // shuffle so a fresh card always gets its full time on top
  useEffect(() => {
    if (dragging) return;
    const t = setInterval(() => setFront((f) => (f + 1) % N), HOLD_MS);
    return () => clearInterval(t);
  }, [front, dragging]);

  const advance = () => setFront((f) => (f + 1) % N);

  return (
    <div className="relative mr-4 mt-6 h-[350px] sm:h-[380px]" aria-label="0xTools feature demos">
      {CARDS.map((card, i) => {
        const pos = (i - front + N) % N; // 0 = front
        const isFront = pos === 0;
        const shown = pos <= 2;
        return (
          <motion.div
            key={card.key}
            initial={false}
            animate={{
              x: reduce ? 0 : pos * 16,
              y: reduce ? 0 : pos * -14,
              rotate: reduce ? 0 : pos === 0 ? -1 : pos === 1 ? 1.5 : 3,
              scale: reduce ? 1 : 1 - pos * 0.04,
              opacity: reduce ? (isFront ? 1 : 0) : shown ? 1 : 0,
            }}
            transition={reduce ? { duration: 0.3 } : SPRING}
            style={{ zIndex: N - pos }}
            drag={isFront && !reduce}
            dragSnapToOrigin
            dragElastic={0.6}
            onDragStart={() => setDragging(true)}
            onDragEnd={(_, info) => {
              setDragging(false);
              if (
                Math.abs(info.offset.x) > 90 ||
                Math.abs(info.velocity.x) > 500 ||
                Math.abs(info.offset.y) > 90
              ) {
                advance();
              }
            }}
            onTap={() => {
              if (isFront && !dragging) advance();
            }}
            className={`absolute inset-0 ${
              isFront ? "cursor-grab active:cursor-grabbing" : "pointer-events-none"
            }`}
          >
            {card.node}
          </motion.div>
        );
      })}
      {/* deck progress — clickable */}
      <div className="absolute -bottom-8 left-0 z-50 flex items-center gap-1.5">
        {CARDS.map((c, i) => (
          <motion.button
            key={c.key}
            type="button"
            aria-label={`Show card ${i + 1}`}
            onClick={() => setFront(i)}
            animate={{
              backgroundColor: i === front ? "#14c08a" : "rgba(138,143,150,0.35)",
              width: i === front ? 22 : 10,
            }}
            transition={{ duration: 0.3 }}
            className="h-2.5 cursor-pointer border border-edge/40"
          />
        ))}
      </div>
      <div className="absolute -bottom-8 right-0 z-50 font-mono text-[10px] text-muted">
        drag / tap to shuffle
      </div>
    </div>
  );
}
