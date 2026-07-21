/* eslint-disable @next/next/no-img-element */

const VERSION = "0.0.5";
const VSIX_PATH = `/downloads/0xtools-${VERSION}.vsix`;
const VSIX_SIZE = "640 KB";
const GITHUB = "https://github.com/0xshubhs/0xtools";

/* ---------- brand mark: the Selector Strip (24 grid · 4 cells · one lit) ---------- */

function Strip({
  className,
  stroke = "#0B0E11",
  lit = "#14C08A",
}: {
  className?: string;
  stroke?: string;
  lit?: string;
}) {
  const cells = [2.65, 7.75, 12.85, 17.95];
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      {cells.map((x, i) =>
        i === 1 ? (
          <rect key={x} x={x} y={6.5} width={3.4} height={11} rx={1.1} fill={lit} />
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

/* ---------- top marquee ---------- */

const TICKER = [
  ["transfer(address,uint256)", "0xa9059cbb"],
  ["balanceOf(address)", "0x70a08231"],
  ["approve(address,uint256)", "0x095ea7b3"],
  ["withdraw(uint256)", "0x2e1a7d4d"],
  ["Transfer(address,address,uint256)", "0xddf252ad"],
  ["swapExactTokensForTokens(...)", "0x38ed1739"],
  ["ownerOf(uint256)", "0x6352211e"],
  ["InsufficientBalance()", "0xf4d678b8"],
];

function Ticker() {
  const row = (
    <span className="flex shrink-0 items-center gap-8 pr-8">
      {TICKER.map(([sig, sel]) => (
        <span key={sel} className="flex items-center gap-2 whitespace-nowrap">
          <span className="text-paper/70">{sig}</span>
          <span className="text-accent">→ {sel}</span>
        </span>
      ))}
    </span>
  );
  return (
    <div className="overflow-hidden border-b-2 border-ink bg-dark py-2 font-mono text-xs">
      <div className="flex w-max animate-marquee">
        {row}
        {row}
      </div>
    </div>
  );
}

/* ---------- nav ---------- */

function Nav() {
  return (
    <nav className="border-b-2 border-ink bg-paper">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-4">
        <a href="#" className="flex items-center gap-3">
          <Strip className="h-10 w-10" />
          <img
            src="/brand/0xtools-wordmark.svg"
            alt="0xTools"
            className="h-6 w-auto"
          />
        </a>
        <div className="flex items-center gap-3 font-mono text-sm">
          <a
            href="#features"
            className="hidden border-b-2 border-transparent px-1 hover:border-accent sm:block"
          >
            FEATURES
          </a>
          <a
            href="#install"
            className="hidden border-b-2 border-transparent px-1 hover:border-accent sm:block"
          >
            INSTALL
          </a>
          <a
            href={GITHUB}
            target="_blank"
            rel="noreferrer"
            className="hidden border-b-2 border-transparent px-1 hover:border-accent sm:block"
          >
            GITHUB ↗
          </a>
          <a
            href={VSIX_PATH}
            download
            className="border-2 border-ink bg-accent px-4 py-2 font-semibold text-ink shadow-brut-sm transition-all hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none"
          >
            GET .VSIX
          </a>
        </div>
      </div>
    </nav>
  );
}

/* ---------- hero ---------- */

function Line({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <span className="block">
      <span className="mr-4 inline-block w-4 select-none text-right text-muted/50">
        {n}
      </span>
      {children}
    </span>
  );
}

function EditorMock() {
  return (
    <div className="relative">
      <div className="border-2 border-ink bg-panel shadow-brut-lg">
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
              <span className="text-accent">deposit</span>(){" "}
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
              <span className="text-accent">withdraw</span>(uint256){" "}
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
      </div>
      {/* hover card */}
      <div className="absolute -bottom-7 -right-3 rotate-[2deg] border-2 border-ink bg-paper px-4 py-3 font-mono text-xs shadow-brut sm:-right-6">
        <div className="mb-1 flex items-center gap-2">
          <Strip className="h-4 w-4" />
          <span className="font-semibold">withdraw(uint256)</span>
        </div>
        <div className="text-muted">
          selector <span className="text-accent-deep">0x2e1a7d4d</span> · 4byte ✓
        </div>
      </div>
    </div>
  );
}

function Hero() {
  return (
    <header className="border-b-2 border-ink">
      <div className="mx-auto grid max-w-6xl items-center gap-12 px-5 py-16 lg:grid-cols-2 lg:py-24 [&>*]:min-w-0">
        <div>
          <div className="mb-6 inline-block -rotate-2 border-2 border-ink bg-amber px-3 py-1 font-mono text-xs font-semibold shadow-brut-sm">
            NOT ON THE MARKETPLACE YET — VSIX SHIPS FROM HERE
          </div>
          <h1 className="text-5xl font-bold leading-[1.02] tracking-tight sm:text-6xl lg:text-7xl">
            Read the{" "}
            <span className="bg-accent px-2 text-ink shadow-brut-sm">EVM</span>{" "}
            without leaving your editor.
          </h1>
          <p className="mt-6 max-w-xl text-lg leading-relaxed text-ink/70">
            0xTools decodes function selectors, event topics and error selectors
            — and annotates gas inline — right inside VS Code. Plus security
            audits, one-click Anvil, and a full EVM toolbox.
          </p>
          <div className="mt-9 flex flex-wrap items-center gap-4">
            <a
              href={VSIX_PATH}
              download
              className="border-2 border-ink bg-accent px-6 py-4 font-mono text-sm font-semibold text-ink shadow-brut transition-all hover:translate-x-[3px] hover:translate-y-[3px] hover:shadow-none"
            >
              ↓ DOWNLOAD .VSIX · v{VERSION} · {VSIX_SIZE}
            </a>
            <a
              href={GITHUB}
              target="_blank"
              rel="noreferrer"
              className="border-2 border-ink bg-paper px-6 py-4 font-mono text-sm font-semibold shadow-brut transition-all hover:translate-x-[3px] hover:translate-y-[3px] hover:shadow-none"
            >
              STAR ON GITHUB ↗
            </a>
          </div>
          <p className="mt-5 font-mono text-xs text-muted">
            MIT licensed · Foundry + Hardhat · works offline
          </p>
        </div>
        <EditorMock />
      </div>
    </header>
  );
}

/* ---------- stats ---------- */

const STATS = [
  ["70+", "COMMANDS"],
  ["3-TIER", "GAS ENGINE"],
  ["4-BYTE", "LOCAL LOOKUP"],
  ["640 KB", "WHOLE VSIX"],
];

function Stats() {
  return (
    <div className="border-b-2 border-ink bg-dark">
      <div className="mx-auto grid max-w-6xl grid-cols-2 sm:grid-cols-4">
        {STATS.map(([big, small]) => (
          <div key={small} className="px-5 py-6 text-center">
            <div className="text-2xl font-bold text-accent sm:text-3xl">{big}</div>
            <div className="mt-1 font-mono text-[11px] tracking-widest text-muted">
              {small}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------- features ---------- */

const FEATURES: [string, string, string, string][] = [
  [
    "01",
    "INLINE GAS",
    "Gas annotations as you type",
    "Real estimates rendered next to every function. Three-tier backend: native Rust runner → Forge → solc-js fallback, so it works on any machine.",
  ],
  [
    "02",
    "SELECTOR DECODING",
    "Hover any 4-byte selector",
    "Function selectors, event topics and error selectors decoded on hover, backed by a local 4-byte cache. Unknown bytes become named signatures.",
  ],
  [
    "03",
    "SECURITY AUDIT",
    "AST-backed detections",
    "Catch reentrancy, unchecked calls and friends while you develop — with inline suppressions and a CLI audit mode for CI.",
  ],
  [
    "04",
    "DEPLOY & RUN",
    "One-click local chain",
    "Start Anvil, deploy contracts, run Foundry scripts and manage keystores from a dashboard — no terminal juggling.",
  ],
  [
    "05",
    "EVM TOOLBOX",
    "A swiss-knife in the palette",
    "Calldata decoder, ABI encoder, unit converter, keccak hashing, address checksums — every conversion you keep opening a browser tab for.",
  ],
  [
    "06",
    "FOUNDRY + HARDHAT",
    "Auto-detects your toolchain",
    "Test CodeLens with inline pass/fail, build diagnostics mapped to your source, and pragma-aware solc versions downloaded on demand.",
  ],
];

function Features() {
  return (
    <section id="features" className="border-b-2 border-ink">
      <div className="mx-auto max-w-6xl px-5 py-16 lg:py-20">
        <div className="mb-3 font-mono text-xs tracking-[0.2em] text-muted">
          01 / WHAT IT DOES
        </div>
        <h2 className="mb-12 max-w-2xl text-4xl font-bold tracking-tight sm:text-5xl">
          The Solidity toolkit that lives{" "}
          <span className="bg-amber px-2 shadow-brut-sm">in the editor.</span>
        </h2>
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map(([num, tag, title, body]) => (
            <div
              key={num}
              className="border-2 border-ink bg-white p-6 shadow-brut transition-all hover:translate-x-[3px] hover:translate-y-[3px] hover:shadow-none"
            >
              <div className="mb-4 flex items-center justify-between">
                <span className="border-2 border-ink bg-accent-tint px-2 py-0.5 font-mono text-[11px] font-semibold text-accent-deep">
                  {tag}
                </span>
                <span className="font-mono text-xs text-muted">{num}</span>
              </div>
              <h3 className="mb-2 text-lg font-bold">{title}</h3>
              <p className="text-sm leading-relaxed text-ink/70">{body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ---------- install ---------- */

function Install() {
  return (
    <section id="install" className="border-b-2 border-ink bg-accent">
      <div className="mx-auto max-w-6xl px-5 py-16 lg:py-20">
        <div className="mb-3 font-mono text-xs tracking-[0.2em] text-ink/60">
          02 / INSTALL
        </div>
        <h2 className="mb-4 text-4xl font-bold tracking-tight sm:text-5xl">
          Three steps. No marketplace.
        </h2>
        <p className="mb-12 max-w-xl text-ink/70">
          We ship the VSIX directly while the marketplace listing is in the
          works. Same extension, zero middlemen.
        </p>
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="border-2 border-ink bg-paper p-6 shadow-brut">
            <div className="mb-3 inline-block border-2 border-ink bg-ink px-3 py-1 font-mono text-sm font-bold text-paper">
              STEP 1
            </div>
            <h3 className="mb-2 font-bold">Download the VSIX</h3>
            <a
              href={VSIX_PATH}
              download
              className="mt-2 inline-block border-2 border-ink bg-white px-4 py-2.5 font-mono text-xs font-semibold shadow-brut-sm transition-all hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none"
            >
              ↓ 0xtools-{VERSION}.vsix
            </a>
          </div>
          <div className="border-2 border-ink bg-paper p-6 shadow-brut">
            <div className="mb-3 inline-block border-2 border-ink bg-ink px-3 py-1 font-mono text-sm font-bold text-paper">
              STEP 2
            </div>
            <h3 className="mb-2 font-bold">Install it</h3>
            <pre className="mt-2 whitespace-pre-wrap break-all border-2 border-ink bg-dark p-3 font-mono text-xs text-accent">
              <code>code --install-extension 0xtools-{VERSION}.vsix</code>
            </pre>
            <p className="mt-3 font-mono text-[11px] leading-relaxed text-muted">
              or: Extensions panel → ··· menu → “Install from VSIX…”
            </p>
          </div>
          <div className="border-2 border-ink bg-paper p-6 shadow-brut">
            <div className="mb-3 inline-block border-2 border-ink bg-ink px-3 py-1 font-mono text-sm font-bold text-paper">
              STEP 3
            </div>
            <h3 className="mb-2 font-bold">Open a .sol file</h3>
            <p className="text-sm leading-relaxed text-ink/70">
              Gas annotations, selector hovers and the{" "}
              <Strip className="inline h-4 w-4 align-text-bottom" /> activity-bar
              dashboard light up automatically.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ---------- footer ---------- */

function Footer() {
  return (
    <footer className="bg-dark text-paper">
      <div className="mx-auto max-w-6xl px-5 py-14">
        <div className="flex flex-wrap items-center justify-between gap-8">
          <div className="flex items-center gap-4">
            <Strip className="h-12 w-12" stroke="#F4F4F1" />
            <img
              src="/brand/0xtools-wordmark-paper.svg"
              alt="0xTools"
              className="h-7 w-auto"
            />
          </div>
          <div className="flex items-center gap-6 font-mono text-sm">
            <a
              href={GITHUB}
              target="_blank"
              rel="noreferrer"
              className="border-b-2 border-transparent hover:border-accent"
            >
              GITHUB ↗
            </a>
            <a
              href={VSIX_PATH}
              download
              className="border-2 border-paper/25 bg-panel px-4 py-2 font-semibold transition-colors hover:border-accent"
            >
              GET .VSIX
            </a>
          </div>
        </div>
        <div className="mt-10 flex flex-wrap items-center justify-between gap-4 border-t border-paper/15 pt-6 font-mono text-xs text-muted">
          <span>0xTools · v{VERSION} · MIT license</span>
          <span>solidity · EVM · selector decoding · inline gas</span>
        </div>
      </div>
    </footer>
  );
}

export default function Home() {
  return (
    <main className="overflow-x-clip">
      <Ticker />
      <Nav />
      <Hero />
      <Stats />
      <Features />
      <Install />
      <Footer />
    </main>
  );
}
