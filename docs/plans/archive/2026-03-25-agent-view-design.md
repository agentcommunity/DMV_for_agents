# Agent View — Full-Page Markdown Takeover

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "For Agents" link in the header that replaces the 3D scene with a full-page monospace view showing install instructions + the raw SKILL.md content, ready to copy-paste.

**Architecture:** New `#agentView` div in index.html, toggled by a header link. When open, the Three.js canvas hides and a dark monospace page appears. Top section has hardcoded install/MCP blocks; below that, SKILL.md is fetched once and rendered as raw text in a `<pre>`. No new JS modules, no markdown parser, no new dependencies.

**Tech Stack:** HTML, CSS, vanilla JS (in app.js)

---

### Task 1: Add HTML structure

**Files:**
- Modify: `index.html:47-52` (header — add "For Agents" link)
- Modify: `index.html:107` (after `data-agent-info` div — add `#agentView`)

- [ ] **Step 1: Add the "For Agents" link to the header**

In `.start-header__left > .header-brand`, add a second link after the About link:

```html
<a href="#" class="header-link" id="agentToggleLink" aria-expanded="false">For Agents</a>
```

The header-brand div (lines 49-52) becomes:

```html
<div class="header-brand">
  <span class="header-brand__title">DMV for agents</span>
  <div class="header-brand__links">
    <a href="#" class="header-link" id="aboutToggleLink" aria-expanded="false">About</a>
    <a href="#" class="header-link" id="agentToggleLink" aria-expanded="false">For Agents</a>
  </div>
</div>
```

- [ ] **Step 2: Add the `#agentView` container**

Insert after the closing `</div>` of `data-agent-info` (line 106), before the closing `</div>` of `.start-screen` (line 107):

```html
<!-- Agent view — full-page markdown takeover for agents -->
<div id="agentView" class="agent-view" hidden>
  <div class="agent-view__content">
    <section class="agent-view__install">
      <h2>Quick Start</h2>

      <h3>CLI (recommended)</h3>
      <pre class="agent-view__code">bunx dmv-agent register</pre>

      <h3>Non-interactive</h3>
      <pre class="agent-view__code">bunx dmv-agent register --name my-agent --email operator@example.com</pre>

      <h3>Claude Code Skill</h3>
      <pre class="agent-view__code">bunx dmv-agent register
# The /dmv skill is bundled — just type /dmv in Claude Code</pre>

      <h3>MCP Server Config</h3>
      <pre class="agent-view__code">{
  "mcpServers": {
    "dmv": {
      "command": "bunx",
      "args": ["dmv-agent"]
    }
  }
}</pre>
    </section>

    <hr class="agent-view__divider">

    <section class="agent-view__skill">
      <pre id="agentViewSkillContent">Loading...</pre>
    </section>
  </div>
</div>
```

- [ ] **Step 3: Verify HTML renders without errors**

Run: `uv run python -m http.server 8080` and open http://localhost:8080. The "For Agents" link should appear next to "About" in the header. The `#agentView` should be hidden (not visible). No console errors.

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat: add For Agents header link and agent-view HTML shell"
```

---

### Task 2: Add CSS for agent view and header links row

**Files:**
- Modify: `css/styles.css` (add `.header-brand__links` flex row, add `.agent-view` styles)

- [ ] **Step 1: Add header links row styling**

After the `.header-link.is-active` block (~line 234), add:

```css
.header-brand__links {
  display: flex;
  gap: 1.6rem;
}
```

This puts "About" and "For Agents" side by side on the same row below the brand title.

- [ ] **Step 2: Add agent view styles**

At the end of the file (before any final media queries or at a logical section), add:

```css
/* === Agent View (full-page markdown takeover) === */
.agent-view {
  position: fixed;
  inset: 0;
  z-index: 50;
  background: #0d0d0d;
  color: #33ff88;
  overflow-y: auto;
  padding: 12rem var(--container-padding) 6rem;
  font-family: var(--floating-ui-font-mono);
  font-size: 1.4rem;
  line-height: 1.7;
}
:root.ui-dark .agent-view {
  color: #ffaa33;
}

.agent-view__content {
  max-width: 72rem;
  margin: 0 auto;
}

.agent-view h2 {
  font-size: 2rem;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  margin-bottom: 1.6rem;
  opacity: 0.9;
}

.agent-view h3 {
  font-size: 1.4rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  margin-top: 2rem;
  margin-bottom: 0.8rem;
  opacity: 0.7;
}

.agent-view__code {
  display: block;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 0.4rem;
  padding: 1.2rem 1.6rem;
  font-family: var(--floating-ui-font-mono);
  font-size: 1.3rem;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
  color: inherit;
  cursor: text;
  -webkit-user-select: all;
  user-select: all;
}

.agent-view__divider {
  border: none;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
  margin: 3.2rem 0;
}

.agent-view__skill pre {
  font-family: var(--floating-ui-font-mono);
  font-size: 1.3rem;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
  color: inherit;
  opacity: 0.85;
  -webkit-user-select: all;
  user-select: all;
}
```

Key decisions:
- `z-index: 50` — above the Three.js canvas (which is in the normal flow) but below the header (`z-index: 100`)
- `padding-top: 12rem` — clears the fixed header
- `user-select: all` on code blocks — one click selects everything for easy copy
- Night mode swaps green to amber via `:root.ui-dark`
- `max-width: 72rem` — readable line length in monospace

- [ ] **Step 3: Bump CSS cache version**

In `index.html`, bump the styles.css version:

```html
<link rel="stylesheet" href="/css/styles.css?v=27">
```

- [ ] **Step 4: Verify styling**

Serve and check: the agent view div is hidden, header links are on one row, no layout shifts. Temporarily remove `hidden` from `#agentView` in devtools to preview the dark page styling.

- [ ] **Step 5: Commit**

```bash
git add css/styles.css index.html
git commit -m "feat: add agent view CSS — dark monospace takeover with CRT palette"
```

---

### Task 3: Wire up toggle logic in app.js

**Files:**
- Modify: `js/app.js` (add DOM refs, toggle functions, event listeners, Escape key, fetch SKILL.md)

- [ ] **Step 1: Add DOM references**

Near the existing `aboutToggleLink` reference (line 30), add:

```javascript
const agentToggleLink = document.getElementById('agentToggleLink');
const agentView = document.getElementById('agentView');
const agentViewSkillContent = document.getElementById('agentViewSkillContent');
```

- [ ] **Step 2: Add agent view state and toggle functions**

After the `closeAbout()` / `syncAboutHover()` block (~line 546), add:

```javascript
// ─── Agent View (full-page markdown for agents) ───────────────────
let agentViewOpen = false;
let skillMdCache = null;

function setAgentLinkActive(active) {
  if (!agentToggleLink) return;
  agentToggleLink.classList.toggle('is-active', active);
  agentToggleLink.setAttribute('aria-expanded', String(active));
}

async function openAgentView() {
  if (agentViewOpen || !agentView) return;

  // Close about if open
  if (aboutPoster.visible) closeAbout();

  // Close card zoom if active and hide share bar
  if (tv.isCardZoomed) {
    holoCard.setVisible(false);
    tv.zoomOutFromCard();
  }
  if (cardShareBar) cardShareBar.hidden = true;

  // Hide 3D scene
  container.style.display = 'none';

  // Fetch SKILL.md once
  if (!skillMdCache) {
    try {
      const resp = await fetch('/packages/dmv-agent/skills/dmv/SKILL.md');
      if (resp.ok) {
        let text = await resp.text();
        // Strip YAML frontmatter (--- ... ---)
        text = text.replace(/^---[\s\S]*?---\n*/, '');
        skillMdCache = text;
      } else {
        skillMdCache = '(Failed to load SKILL.md)';
      }
    } catch {
      skillMdCache = '(Failed to load SKILL.md)';
    }
  }
  if (agentViewSkillContent) {
    agentViewSkillContent.textContent = skillMdCache;
  }

  agentView.hidden = false;
  agentViewOpen = true;
  setAgentLinkActive(true);
}

function closeAgentView() {
  if (!agentViewOpen) return;
  agentView.hidden = true;
  container.style.display = '';
  agentViewOpen = false;
  setAgentLinkActive(false);
}
```

Key details:
- Null guard on `agentView` prevents errors if HTML isn't present
- Hides `cardShareBar` to clean up any card-zoom UI state
- Strips YAML frontmatter so the raw view starts at `# DMV — Agent Identity Registration`
- Caches after first fetch — no repeated network requests
- Uses `.textContent` (not `.innerHTML`) — safe, no XSS risk, renders as plain text
- Hides the canvas wrapper (`container`) entirely so Three.js doesn't render behind it
- Note: Three.js render loop continues running while hidden (acceptable — no visual cost, avoids resize bugs on restore)

- [ ] **Step 3: Add click listener for the "For Agents" link**

After the existing about toggle click listener block (~line 718), add:

```javascript
if (!permalink && agentToggleLink) {
  agentToggleLink.addEventListener('click', (e) => {
    e.preventDefault();
    if (agentViewOpen) {
      closeAgentView();
      return;
    }
    openAgentView();
  });
}
```

- [ ] **Step 4: Close about when opening agent view (and vice versa)**

Modify the existing about toggle click handler (lines 709-718) to close agent view first:

```javascript
if (!permalink && aboutToggleLink) {
  aboutToggleLink.addEventListener('click', (e) => {
    e.preventDefault();
    // Close agent view if open
    if (agentViewOpen) closeAgentView();
    if (aboutPoster.visible) {
      closeAbout();
      return;
    }
    openAbout();
  });
}
```

- [ ] **Step 5: Add Escape key handling for agent view**

In the `keydown` handler (line 912), add a new early check before the about-zoomed block:

```javascript
if (agentViewOpen) {
  if (e.key === 'Escape') {
    e.preventDefault();
    closeAgentView();
  }
  return; // swallow all keys while agent view is open
}
```

This goes before the `if (tv.isAboutZoomed)` check at line 913.

- [ ] **Step 6: Handle permalink mode**

In the permalink block (~line 596-608), after the about link override, add:

```javascript
if (agentToggleLink) {
  agentToggleLink.style.display = 'none';
}
```

The "For Agents" link is hidden in permalink mode — it's not relevant when viewing a shared card.

- [ ] **Step 7: Bump JS cache version**

In `index.html`:

```html
<script type="module" src="/js/app.js?v=29"></script>
```

- [ ] **Step 8: Test the full flow**

Serve and verify:
1. Click "For Agents" → 3D scene disappears, dark page with install blocks + SKILL.md text appears
2. Click "For Agents" again → agent view closes, 3D scene returns
3. Click "About" while agent view is open → agent view closes, about opens
4. Press Escape while agent view is open → closes
5. Night mode toggle still works (amber text in agent view)
6. Permalink mode (`/c/TEST-123/test`) → "For Agents" link hidden
7. No console errors in any state

- [ ] **Step 9: Commit**

```bash
git add js/app.js index.html
git commit -m "feat: wire agent view toggle — fetches SKILL.md, hides 3D scene, Escape to close"
```

---

### Task 4: Polish and edge cases

**Files:**
- Modify: `js/app.js` (hide footer/CTA when agent view open)
- Modify: `css/styles.css` (scrollbar styling, mobile adjustments)

- [ ] **Step 1: Hide footer and center CTA when agent view is open**

In `openAgentView()`, after setting `agentView.hidden = false`:

```javascript
const footer = document.querySelector('.start-screen__footer');
const centerCta = document.getElementById('centerCta');
if (footer) footer.style.display = 'none';
if (centerCta) centerCta.style.display = 'none';
```

In `closeAgentView()`, before setting `agentViewOpen = false`:

```javascript
const footer = document.querySelector('.start-screen__footer');
const centerCta = document.getElementById('centerCta');
if (footer) footer.style.display = '';
if (centerCta) centerCta.style.display = '';
```

- [ ] **Step 2: Style the scrollbar for agent view**

In `css/styles.css`, in the agent view section:

```css
.agent-view::-webkit-scrollbar { width: 0.6rem; }
.agent-view::-webkit-scrollbar-track { background: transparent; }
.agent-view::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.15); border-radius: 0.3rem; }
```

- [ ] **Step 3: Mobile padding adjustments**

The existing `--container-padding` responsive breakpoints handle horizontal padding. Verify the `12rem` top padding works at mobile widths. If the header is smaller on mobile, adjust:

```css
@media (max-width: 767px) {
  .agent-view { padding-top: 10rem; }
}
```

- [ ] **Step 4: Test on mobile viewport**

Use devtools responsive mode (375px width). Verify:
- Content doesn't overflow horizontally
- Code blocks wrap properly (`white-space: pre-wrap` + `word-break: break-all`)
- Scrolling works
- Header links don't collide

- [ ] **Step 5: Bump CSS cache version**

In `index.html`, bump:

```html
<link rel="stylesheet" href="/css/styles.css?v=28">
```

- [ ] **Step 6: Commit**

```bash
git add js/app.js css/styles.css index.html
git commit -m "feat: polish agent view — hide footer/CTA, scrollbar styling, mobile padding"
```
