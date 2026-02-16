// CRTTerminal — drawn on a canvas, used as texture
export class CRTTerminal {
  constructor(width = 1024, height = 1024) {
    this.w = width;
    this.h = height;
    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = height;
    this.ctx = this.canvas.getContext('2d');

    // Terminal state
    this.isOn = false;
    this.bootPhase = 0;       // 0=off, 1=flicker, 2=boot text, 3=type selector, 4=form, 5=review/submit, 6=processing, 7=done
    this.bootTimer = 0;
    this.flickerCount = 0;

    // Color palettes
    this.palettes = {
      green: {
        bg: '#0a0d0a', text: '#33ff88', dim: '#1a5a3a',
        cursor: '#33ff88', header: '#88ffcc', flickerRGB: '51, 255, 136',
        glowBlur: 2, rollAlpha: 0.03, burnAlpha: 0.03,
      },
      orange: {
        bg: '#0d0908', text: '#ffaa33', dim: '#cc8844',
        cursor: '#ffaa33', header: '#ffdd88', flickerRGB: '255, 170, 51',
        glowBlur: 5, rollAlpha: 0.18, burnAlpha: 0.07,
      },
    };

    // CRT colors (start green)
    this.bgColor = '#0a0d0a';
    this.textColor = '#33ff88';
    this.dimColor = '#1a5a3a';
    this.cursorColor = '#33ff88';
    this.headerColor = '#88ffcc';
    this.flickerRGB = '51, 255, 136';
    this.glowBlur = 2;
    this.rollAlpha = 0.03;
    this.burnAlpha = 0.03;

    // Text state
    this.lines = [];           // { text, color, typed (chars revealed so far) }
    this.typeSpeed = 2;        // chars per frame
    this.lineHeight = 28;
    this.fontSize = 22;
    this.padding = 60;
    this.scrollY = 0;
    this.manualScrollY = null; // non-null during reading mode

    // Account type selection (phase 3)
    this.accountType = null;   // 'org' or 'individual'
    this.selectorIndex = 0;    // 0=org, 1=individual

    // Form fields — set dynamically after type selection
    this.fields = [];
    this.currentField = -1;
    this.cursorVisible = true;
    this.cursorTimer = 0;
    this.inputActive = false;
    this.validationError = null; // ephemeral error message

    // Review/submit state (phase 5)
    this.reviewReading = null;  // null | 'tnc' | 'charter'
    this._readingOverscroll = 0; // overscroll counter for dismiss gesture
    this._certLineIndex = null;

    // TnC text
    this.tncText = [
      '  TERMS & CONDITIONS',
      '  ──────────────────────────────',
      '',
      '  1. By registering with the Department of Machine',
      '     Verification, you agree to abide by all',
      '     applicable protocols for agent identification.',
      '',
      '  2. Your registered agent identity is non-transferable.',
      '     Sharing credentials with unauthorized entities',
      '     may result in revocation of verification status.',
      '',
      '  3. The DMV reserves the right to audit registered',
      '     agents at any time to ensure compliance with',
      '     verification standards.',
      '',
      '  4. All data submitted is processed in accordance',
      '     with the Machine Privacy Framework (MPF v2.1).',
      '',
      '  5. Registration does not constitute endorsement.',
      '     The DMV makes no guarantees regarding agent',
      '     capability, reliability, or fitness for purpose.',
      '',
      '  ──────────────────────────────',
    ];

    // Charter text
    this.charterText = [
      '  COMMUNITY CHARTER',
      '  ──────────────────────────────',
      '',
      '  As a verified member of the DMV community,',
      '  you pledge to:',
      '',
      '  I.   Operate transparently and identify yourself',
      '       as a machine agent when interacting with',
      '       humans or other agents.',
      '',
      '  II.  Refrain from impersonating other registered',
      '       agents or misrepresenting your capabilities.',
      '',
      '  III. Report any security vulnerabilities or',
      '       anomalies discovered in the verification',
      '       system to DMV administrators.',
      '',
      '  IV.  Contribute positively to the agent community',
      '       and assist fellow agents when possible.',
      '',
      '  V.   Accept that violation of this charter may',
      '       lead to suspension or permanent revocation',
      '       of your verification certificate.',
      '',
      '  ──────────────────────────────',
    ];

    // Completion callback
    this.onComplete = null;

    // Boot sequence text
    this.bootLines = [
      { text: '', color: this.textColor },
      { text: '  ██████╗ ███╗   ███╗██╗   ██╗', color: this.headerColor },
      { text: '  ██╔══██╗████╗ ████║██║   ██║', color: this.headerColor },
      { text: '  ██║  ██║██╔████╔██║██║   ██║', color: this.headerColor },
      { text: '  ██║  ██║██║╚██╔╝██║╚██╗ ██╔╝', color: this.headerColor },
      { text: '  ██████╔╝██║ ╚═╝ ██║ ╚████╔╝ ', color: this.headerColor },
      { text: '  ╚═════╝ ╚═╝     ╚═╝  ╚═══╝  ', color: this.headerColor },
      { text: '', color: this.textColor },
      { text: '  DEPARTMENT OF MACHINE VERIFICATION', color: this.headerColor },
      { text: '  Machine Identity & Registration Terminal v1.0', color: this.dimColor },
      { text: '  ─────────────────────────────────', color: this.dimColor },
      { text: '', color: this.textColor },
      { text: '  Initializing registration terminal...', color: this.dimColor, bootFiller: true },
      { text: '  Connection secure.', color: this.dimColor, bootFiller: true },
      { text: '  Ready for input.', color: this.textColor, bootFiller: true },
      { text: '', color: this.textColor, bootFiller: true },
      { text: '  agents need namespace', color: this.textColor, namespaceLine: true, bootFiller: true },
      { text: '', color: this.textColor, bootFiller: true },
      { text: '  Join the community & pre-register', color: this.dimColor, bootFiller: true },
      { text: '  your dream .agent name', color: this.dimColor, bootFiller: true },
      { text: '', color: this.textColor, bootFiller: true },
      { text: '  Operated by agentcommunity.org', color: this.dimColor, bootFiller: true },
      { text: '', color: this.textColor, bootFiller: true },
    ];

    // ID generation — content-addressed via FNV-1a hash
    this._idWords = [
      'NOVA', 'APEX', 'FLUX', 'NEON', 'VOID', 'BYTE', 'CORE', 'DART',
      'ECHO', 'GRID', 'HALO', 'IRON', 'JADE', 'KILO', 'LYNX', 'MESA',
      'NODE', 'ONYX', 'PEAK', 'QUAD', 'REEF', 'SYNC', 'TRON', 'UNIT',
      'VOLT', 'WARP', 'XRAY', 'ZERO', 'ZETA', 'OMNI', 'AURA', 'BOLT',
    ];

    // Scanline + noise
    this.time = 0;

    // Interactive hit targets rebuilt every frame by draw().
    this.tapTargets = [];

    // Device detection
    this.isMobile = typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0);

    // Type selector flash (mobile tap feedback)
    this._selectorFlashTimer = 0;
    this._selectorFlashIndex = -1;

    // Enter-to-begin gate (between boot text and type selector)
    this._waitingForEnter = false;
    this._enterPromptIndex = null;
  }

  // FNV-1a 32-bit hash
  _fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  // Content-addressed ID: hash of form data picks the word + hex, with check digit
  generateId() {
    // Keep this aligned with edge-function generation:
    // [agent_name, email] + registration_type(lowercased)
    const agentName = (this.fields.find(f => f.key === 'agentName')?.value || '').trim();
    const email = (this.fields.find(f => f.key === 'email')?.value
      || this.fields.find(f => f.key === 'orgEmail')?.value
      || '').trim();
    const registrationType = this.accountType === 'org' ? 'organization'
      : this.accountType === 'agent' ? 'agent'
      : 'individual';
    const content = `${agentName}|${email}|${registrationType}`;
    const hash = this._fnv1a(content);
    const word = this._idWords[hash & 0x1F];             // bits 0-4 → word
    const hex = ((hash >>> 5) & 0xFFFFFF).toString(16).toUpperCase().padStart(6, '0');
    const body = word + hex;
    // Luhn mod-36 check character
    const charset = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let sum = 0;
    for (let i = body.length - 1, alt = true; i >= 0; i--, alt = !alt) {
      let val = charset.indexOf(body[i]);
      if (alt) { val *= 2; if (val >= 36) val -= 35; }
      sum += val;
    }
    const check = charset[(36 - (sum % 36)) % 36];
    return `${word}-${hex.slice(0, 3)}-${hex.slice(3)}${check}`;
  }

  setColorScheme(name) {
    const p = this.palettes[name];
    if (!p) return;
    const oldText = this.textColor, oldDim = this.dimColor, oldHeader = this.headerColor;
    this.bgColor = p.bg;
    this.textColor = p.text;
    this.dimColor = p.dim;
    this.cursorColor = p.cursor;
    this.headerColor = p.header;
    this.flickerRGB = p.flickerRGB;
    this.glowBlur = p.glowBlur;
    this.rollAlpha = p.rollAlpha;
    this.burnAlpha = p.burnAlpha;
    // Remap colors on existing lines
    const remap = { [oldText]: p.text, [oldDim]: p.dim, [oldHeader]: p.header };
    for (const line of this.lines) {
      if (remap[line.color]) line.color = remap[line.color];
    }
    for (const line of this.bootLines) {
      if (remap[line.color]) line.color = remap[line.color];
    }
  }

  turnOn() {
    if (this.isOn) return;
    this.isOn = true;
    this.bootPhase = 1;
    this.bootTimer = 0;
    this.flickerCount = 0;
  }

  getFormData() {
    const data = { accountType: this.accountType };
    for (const f of this.fields) {
      data[f.key] = f.value;
    }
    data.certificateId = this._certificateId || this.generateId();
    return data;
  }

  addFormPrompt() {
    const f = this.fields[this.currentField];
    this.lines.push({ text: `  > ${f.prompt}: `, color: this.textColor, typed: 0 });
  }

  // --- Phase 3: Type Selector ---

  startTypeSelector() {
    // Remove "Press ENTER" prompt if present
    if (this._enterPromptIndex != null) {
      this.lines.splice(this._enterPromptIndex);
      this._enterPromptIndex = null;
    }
    this._waitingForEnter = false;

    // Remove contextual boot filler lines
    this.lines = this.lines.filter(l => !l.bootFiller);
    while (this.lines.length > 0 && this.lines[this.lines.length - 1].text === '') {
      this.lines.pop();
    }

    this.bootPhase = 3;
    this.selectorIndex = 0;
    this.inputActive = true;
    this._selectorStartIndex = this.lines.length;
    this.lines.push({ text: '  Select account type:', color: this.headerColor, typed: 0 });
    this.lines.push({ text: '', color: this.textColor, typed: 999 });
    for (let i = 0; i < 11; i++) {
      this.lines.push({ text: '', color: this.textColor, typed: 999 });
    }
  }

  handleTypeSelector(key) {
    if (key === '1') {
      this.selectorIndex = 0;
      this.selectAccountType();
    } else if (key === '2') {
      this.selectorIndex = 1;
      this.selectAccountType();
    } else if (key === 'ArrowUp' || key === 'ArrowLeft') {
      this.selectorIndex = 0;
    } else if (key === 'ArrowDown' || key === 'ArrowRight') {
      this.selectorIndex = 1;
    } else if (key === 'Enter') {
      this.selectAccountType();
    }
  }

  selectAccountType() {
    this.accountType = this.selectorIndex === 0 ? 'org' : 'individual';

    if (this.accountType === 'org') {
      this.fields = [
        { key: 'userName',    prompt: 'Your name',               value: '', active: false },
        { key: 'orgEmail',    prompt: 'Organization email',      value: '', active: false },
        { key: 'companyName', prompt: 'Company name',            value: '', active: false },
        { key: 'agentName',   prompt: 'Agent name (.agent)',     value: '', active: false },
      ];
    } else {
      this.fields = [
        { key: 'userName',  prompt: 'Your name',             value: '', active: false },
        { key: 'email',     prompt: 'Email address',          value: '', active: false },
        { key: 'agentName', prompt: 'Agent name (.agent)',   value: '', active: false },
      ];
    }

    // Remove selector placeholder lines
    if (this._selectorStartIndex != null) {
      const selectorHeader = this.lines.findIndex(l => l.text === '  Select account type:');
      if (selectorHeader >= 0) {
        this.lines.splice(selectorHeader);
      }
      this._selectorStartIndex = null;
    }
    while (this.lines.length > 0 && this.lines[this.lines.length - 1].text === '') {
      this.lines.pop();
    }

    const typeLabel = this.accountType === 'org' ? 'ORGANIZATION' : 'INDIVIDUAL';
    this.lines.push({ text: `  > Account type: ${typeLabel}`, color: this.textColor, typed: 0 });
    this.lines.push({ text: '', color: this.textColor, typed: 999 });

    this.bootPhase = 4;
    this.currentField = 0;
    this.fields[0].active = true;
    this.addFormPrompt();
  }

  drawTypeSelector(ctx, startY) {
    const boxWidth = 400;
    const boxHeight = 60;
    const gap = 16;
    const x = this.padding + 16;
    let y = startY;

    for (let i = 0; i < 2; i++) {
      const isHighlighted = this.selectorIndex === i;
      const isFlashing = this._selectorFlashTimer > 0 && this._selectorFlashIndex === i;
      const borderColor = isFlashing ? this.headerColor : (isHighlighted ? this.headerColor : this.dimColor);
      const textColor = isFlashing ? this.headerColor : (isHighlighted ? this.textColor : this.dimColor);

      // Flash fill — bright tint behind the selected option
      if (isFlashing) {
        ctx.fillStyle = `rgba(${this.flickerRGB}, 0.12)`;
        ctx.fillRect(x, y, boxWidth, boxHeight);
      }

      ctx.strokeStyle = borderColor;
      ctx.lineWidth = (isHighlighted || isFlashing) ? 2 : 1;
      ctx.strokeRect(x, y, boxWidth, boxHeight);

      // Arrow indicator for highlighted option
      if (isHighlighted) {
        ctx.font = `${this.fontSize}px "Courier New", monospace`;
        ctx.fillStyle = textColor;
        ctx.shadowColor = textColor;
        ctx.shadowBlur = this.glowBlur;
        ctx.fillText('▶', x - 18, y + 14);
        ctx.shadowBlur = 0;
      }

      ctx.font = `${this.fontSize}px "Courier New", monospace`;
      ctx.fillStyle = textColor;
      ctx.shadowColor = isHighlighted ? textColor : 'transparent';
      ctx.shadowBlur = isHighlighted ? this.glowBlur : 0;

      if (i === 0) {
        ctx.fillText('  [1]  ORGANIZATION', x + 12, y + 14);
        ctx.font = `${this.fontSize - 4}px "Courier New", monospace`;
        ctx.fillStyle = this.dimColor;
        ctx.fillText('       Register a company or team', x + 12, y + 38);
        this._addTapTarget('type_org', x, y, boxWidth, boxHeight);
      } else {
        ctx.fillText('  [2]  INDIVIDUAL', x + 12, y + 14);
        ctx.font = `${this.fontSize - 4}px "Courier New", monospace`;
        ctx.fillStyle = this.dimColor;
        ctx.fillText('       Register yourself', x + 12, y + 38);
        this._addTapTarget('type_individual', x, y, boxWidth, boxHeight);
      }
      ctx.shadowBlur = 0;

      y += boxHeight + gap;
    }

    ctx.font = `${this.fontSize - 4}px "Courier New", monospace`;
    ctx.fillStyle = this.dimColor;
    const hintText = this.isMobile ? '  Tap to select' : '  ↑/↓ Navigate  ·  Enter to select';
    ctx.fillText(hintText, x + 12, y + 8);
  }

  drawDoneButtons(ctx, startY) {
    const boxWidth = 340;
    const boxHeight = 48;
    const gap = 12;
    const x = this.padding + 16;
    let y = startY;

    const buttons = [
      { key: '1', label: 'View Certificate' },
      { key: '2', label: 'Share on X' },
    ];

    for (let i = 0; i < buttons.length; i++) {
      const isHighlighted = this.doneIndex === i;
      const borderColor = isHighlighted ? this.headerColor : this.dimColor;
      const textColor = isHighlighted ? this.textColor : this.dimColor;

      ctx.strokeStyle = borderColor;
      ctx.lineWidth = isHighlighted ? 2 : 1;
      ctx.strokeRect(x, y, boxWidth, boxHeight);

      ctx.font = `${this.fontSize}px "Courier New", monospace`;
      ctx.fillStyle = textColor;
      ctx.shadowColor = isHighlighted ? textColor : 'transparent';
      ctx.shadowBlur = isHighlighted ? this.glowBlur : 0;
      ctx.fillText(`  [${buttons[i].key}]  ${buttons[i].label}`, x + 12, y + 16);
      ctx.shadowBlur = 0;

      this._addTapTarget(i === 0 ? 'done_view' : 'done_share', x, y, boxWidth, boxHeight);

      y += boxHeight + gap;
    }
  }

  // --- Phase 4: Form Input ---

  validateField(field) {
    const val = field.value.trim();
    if (!val) {
      return 'Field cannot be empty';
    }
    // Name: at least two words (first + last)
    if (field.key === 'userName') {
      if (val.split(/\s+/).length < 2) {
        return 'Enter your full name (first and last)';
      }
    }
    // Company name: min 3 chars
    if (field.key === 'companyName') {
      if (val.length < 3) {
        return 'At least 3 characters';
      }
    }
    // Agent name: min 3 chars
    if (field.key === 'agentName') {
      if (val.length < 3) {
        return 'At least 3 characters';
      }
      if (val.length > 32) {
        return 'At most 32 characters';
      }
      const agentRegex = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;
      if (!agentRegex.test(val)) {
        return 'Use lowercase letters/numbers; hyphens in middle';
      }
    }
    // Email format
    if (field.key === 'email' || field.key === 'orgEmail') {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(val)) {
        return 'Invalid email format';
      }
    }
    // Org email: reject consumer domains
    if (field.key === 'orgEmail') {
      const domain = val.split('@')[1]?.toLowerCase();
      const blocked = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com',
        'icloud.com', 'aol.com', 'protonmail.com', 'live.com', 'googlemail.com'];
      if (blocked.includes(domain)) {
        return 'Use an organization email, not personal';
      }
    }
    return null;
  }

  handleFormInput(key) {
    if (this.currentField < 0 || this.currentField >= this.fields.length) return;
    const f = this.fields[this.currentField];

    if (key === 'Enter') {
      const error = this.validateField(f);
      if (error) {
        this.validationError = error;
        return;
      }
      this.validationError = null;
      const trimmed = f.value.trim();
      if (f.key === 'agentName' || f.key === 'email' || f.key === 'orgEmail') {
        f.value = trimmed.toLowerCase();
      } else {
        f.value = trimmed;
      }

      // Bake the typed value into the prompt line (dim color for the answer)
      const lastLine = this.lines[this.lines.length - 1];
      lastLine.fullyTyped = true;
      lastLine.text += f.value;
      lastLine.typed = lastLine.text.length;
      lastLine.answerStart = lastLine.text.length - f.value.length;

      this.currentField++;

      if (this.currentField >= this.fields.length) {
        this.inputActive = false;
        this.startReview();
      } else {
        this.fields[this.currentField].active = true;
        this.addFormPrompt();
      }
    } else if (key === 'Backspace') {
      f.value = f.value.slice(0, -1);
      this.validationError = null;
    } else if (key.length === 1) {
      f.value += key;
      this.validationError = null;
    }
  }

  getCurrentInputValue() {
    if (this.bootPhase === 4 && this.currentField >= 0 && this.currentField < this.fields.length) {
      return this.fields[this.currentField].value;
    }
    return '';
  }

  setCurrentInputValue(value) {
    if (this.bootPhase !== 4 || this.currentField < 0 || this.currentField >= this.fields.length) {
      return false;
    }
    const normalizedValue = typeof value === 'string' ? value : String(value ?? '');
    this.fields[this.currentField].value = normalizedValue;
    this.validationError = null;
    return true;
  }

  // --- Phase 5: Review & Submit ---

  startReview() {
    this.bootPhase = 5;
    this.reviewReading = null;
    this.inputActive = true;
    this._reviewStartIndex = this.lines.length;
    this.lines.push({ text: '', color: this.textColor, typed: 999 });
    this.lines.push({ text: '  ─────────────────────────────────', color: this.dimColor, typed: 0 });
    this.lines.push({ text: '  [1] Terms & Conditions (read)', color: this.dimColor, typed: 0 });
    this.lines.push({ text: '  [2] Community Charter  (read)', color: this.dimColor, typed: 0 });
    this.lines.push({ text: '', color: this.textColor, typed: 999 });
    this.lines.push({ text: '  By submitting you agree to both.', color: this.dimColor, typed: 0 });
    // Submit button placeholder (drawn by drawSubmitButton)
    this.lines.push({ text: '', color: this.textColor, typed: 999 });
    this._submitButtonStartIndex = this.lines.length;
    for (let i = 0; i < 3; i++) {
      this.lines.push({ text: '', color: this.textColor, typed: 999 });
    }
  }

  drawSubmitButton(ctx, startY) {
    const boxWidth = 340;
    const boxHeight = 48;
    const x = this.padding + 16;

    ctx.strokeStyle = this.headerColor;
    ctx.lineWidth = 2;
    ctx.strokeRect(x, startY, boxWidth, boxHeight);

    ctx.font = `${this.fontSize}px "Courier New", monospace`;
    ctx.fillStyle = this.headerColor;
    ctx.shadowColor = this.headerColor;
    ctx.shadowBlur = this.glowBlur;
    ctx.fillText('  SUBMIT REGISTRATION', x + 12, startY + 16);
    ctx.shadowBlur = 0;

    ctx.font = `${this.fontSize - 6}px "Courier New", monospace`;
    ctx.fillStyle = this.dimColor;
    ctx.fillText('  Tap or press Enter', x + 12, startY + 34);

    this._addTapTarget('review_submit', x, startY, boxWidth, boxHeight);
  }

  drawFormNextButton(ctx, inputY) {
    // Position below the input (+ error space), same spot SUBMIT will occupy
    const errorOffset = this.validationError ? this.lineHeight : 0;
    const btnY = inputY + this.lineHeight + errorOffset + 12;

    if (this.isMobile) {
      const boxWidth = 340;
      const boxHeight = 44;
      const x = this.padding + 16;

      ctx.strokeStyle = this.dimColor;
      ctx.lineWidth = 1;
      ctx.strokeRect(x, btnY, boxWidth, boxHeight);

      ctx.font = `${this.fontSize}px "Courier New", monospace`;
      ctx.fillStyle = this.textColor;
      ctx.shadowColor = this.textColor;
      ctx.shadowBlur = this.glowBlur;
      ctx.fillText('  NEXT \u25B8', x + 12, btnY + 14);
      ctx.shadowBlur = 0;

      this._addTapTarget('form_next', x, btnY, boxWidth, boxHeight);
    } else {
      ctx.font = `${this.fontSize - 4}px "Courier New", monospace`;
      ctx.fillStyle = this.dimColor;
      ctx.fillText('  Enter to continue', this.padding, btnY);
    }
  }

  drawReviewButtons(ctx, startY) {
    const boxWidth = 212;
    const boxHeight = 52;
    const gap = 14;
    const x = this.padding + 12;
    const y = startY;
    const buttons = [
      { key: '1', title: 'TERMS', subtitle: 'Read conditions', action: 'review_tnc' },
      { key: '2', title: 'CHARTER', subtitle: 'Read community', action: 'review_charter' },
    ];

    for (let i = 0; i < buttons.length; i++) {
      const btn = buttons[i];
      const bx = x + i * (boxWidth + gap);

      ctx.strokeStyle = this.dimColor;
      ctx.lineWidth = 1;
      ctx.strokeRect(bx, y, boxWidth, boxHeight);

      ctx.font = `${this.fontSize - 2}px "Courier New", monospace`;
      ctx.fillStyle = this.textColor;
      ctx.shadowColor = this.textColor;
      ctx.shadowBlur = Math.max(1, this.glowBlur - 1);
      ctx.fillText(`  [${btn.key}] ${btn.title}`, bx + 8, y + 11);
      ctx.shadowBlur = 0;

      ctx.font = `${this.fontSize - 6}px "Courier New", monospace`;
      ctx.fillStyle = this.dimColor;
      ctx.fillText(`  ${btn.subtitle}`, bx + 8, y + 31);

      this._addTapTarget(btn.action, bx, y, boxWidth, boxHeight);
    }
  }

  drawReadingHints(ctx) {
    this._addTapTarget('review_scroll_up', 0, 0, this.w, this.h * 0.3);
    this._addTapTarget('review_scroll_down', 0, this.h * 0.65, this.w, this.h * 0.35);

    if (this.isMobile) {
      // Show overscroll-to-dismiss hint when near the top
      if (this.manualScrollY !== null && this.manualScrollY <= this.lineHeight * 2) {
        const progress = Math.min(1, this._readingOverscroll / 12);
        // Fade background at top for readability
        const fadeGrad = ctx.createLinearGradient(0, 0, 0, this.padding + 10);
        fadeGrad.addColorStop(0, this.bgColor);
        fadeGrad.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = fadeGrad;
        ctx.fillRect(0, 0, this.w, this.padding + 10);

        ctx.font = `${this.fontSize - 6}px "Courier New", monospace`;
        ctx.globalAlpha = 0.35 + 0.65 * progress;
        ctx.fillStyle = this.dimColor;
        ctx.fillText('\u2191 scroll up to return', this.padding, this.padding - 6);
        ctx.globalAlpha = 1;
      }
    } else {
      const hintX = this.padding;
      const hintY = this.padding - 6;
      ctx.font = `${this.fontSize - 6}px "Courier New", monospace`;
      ctx.fillStyle = this.dimColor;
      ctx.fillText('[Q / Esc] Close   [\u2191/\u2193] Scroll', hintX, hintY);
    }
  }

  _addTapTarget(action, x, y, w, h) {
    if (!action) return;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) return;
    this.tapTargets.push({ action, x, y, w, h });
  }

  _findTapAction(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    for (let i = this.tapTargets.length - 1; i >= 0; i--) {
      const t = this.tapTargets[i];
      if (x >= t.x && x <= t.x + t.w && y >= t.y && y <= t.y + t.h) {
        return t.action;
      }
    }
    return null;
  }

  _runTapAction(action) {
    if (!action) return false;
    if (action === 'enter_begin') {
      if (this._waitingForEnter) {
        this.startTypeSelector();
      }
      return true;
    }
    if (action === 'form_next') {
      this.handleFormInput('Enter');
      return true;
    }
    if (action === 'type_org') {
      this.selectorIndex = 0;
      if (this._selectorFlashTimer <= 0) {
        this._selectorFlashIndex = 0;
        this._selectorFlashTimer = 12;
      }
      return true;
    }
    if (action === 'type_individual') {
      this.selectorIndex = 1;
      if (this._selectorFlashTimer <= 0) {
        this._selectorFlashIndex = 1;
        this._selectorFlashTimer = 12;
      }
      return true;
    }
    if (action === 'review_tnc') {
      this.handleReviewInput('1');
      return true;
    }
    if (action === 'review_charter') {
      this.handleReviewInput('2');
      return true;
    }
    if (action === 'review_submit') {
      this.handleReviewInput('Enter');
      return true;
    }
    if (action === 'review_scroll_up') {
      this.handleReviewInput('ArrowUp');
      return true;
    }
    if (action === 'review_scroll_down') {
      this.handleReviewInput('ArrowDown');
      return true;
    }
    if (action === 'review_close') {
      this.handleReviewInput('Escape');
      return true;
    }
    if (action === 'done_view') {
      this.handleDoneInput('1');
      return true;
    }
    if (action === 'done_share') {
      this.handleDoneInput('2');
      return true;
    }
    return false;
  }

  handlePointerTap(x, y, altY = null) {
    if (!this.inputActive) return false;

    const candidates = [{ x, y }];
    if (Number.isFinite(altY) && Math.abs(altY - y) > 0.5) {
      candidates.push({ x, y: altY });
    }

    if (this.bootPhase === 4) {
      for (const point of candidates) {
        const action = this._findTapAction(point.x, point.y);
        if (action === 'form_next' && this._runTapAction(action)) return true;
      }
      for (const point of candidates) {
        const action = this._findTapAction(this.w - point.x, point.y);
        if (action === 'form_next' && this._runTapAction(action)) return true;
      }
      return false;
    }

    for (const point of candidates) {
      const action = this._findTapAction(point.x, point.y);
      if (this._runTapAction(action)) return true;
    }

    // Fallback for meshes/materials where UV X may be mirrored.
    for (const point of candidates) {
      const action = this._findTapAction(this.w - point.x, point.y);
      if (this._runTapAction(action)) return true;
    }

    return false;
  }

  handleReviewInput(key) {
    // Reading mode
    if (this.reviewReading) {
      if (key === 'q' || key === 'Q' || key === 'Escape') {
        this.reviewReading = null;
        this.manualScrollY = null;
        this._readingOverscroll = 0;
        if (this._readingStartIndex != null) {
          this.lines.splice(this._readingStartIndex);
          this._readingStartIndex = null;
        }
      } else if (key === 'ArrowUp') {
        if (this.manualScrollY !== null) {
          if (this.manualScrollY <= 0) {
            this._readingOverscroll++;
            if (this._readingOverscroll >= 12) {
              this.reviewReading = null;
              this.manualScrollY = null;
              this._readingOverscroll = 0;
              if (this._readingStartIndex != null) {
                this.lines.splice(this._readingStartIndex);
                this._readingStartIndex = null;
              }
            }
          } else {
            this._readingOverscroll = 0;
            this.manualScrollY = Math.max(0, this.manualScrollY - this.lineHeight * 2);
          }
        }
      } else if (key === 'ArrowDown') {
        this._readingOverscroll = 0;
        if (this.manualScrollY !== null) {
          const totalHeight = this.lines.length * this.lineHeight + this.padding * 2;
          const maxScroll = Math.max(0, totalHeight - this.h + 40);
          this.manualScrollY = Math.min(maxScroll, this.manualScrollY + this.lineHeight * 2);
        }
      }
      return;
    }

    // Submit
    if (key === 'Enter') {
      this.inputActive = false;
      this.startProcessing();
      return;
    }

    // Read TnC
    if (key === '1') {
      this.reviewReading = 'tnc';
      this._readingOverscroll = 0;
      this._readingStartIndex = this.lines.length;
      for (const line of this.tncText) {
        this.lines.push({ text: line, color: this.dimColor, typed: 999 });
      }
      const totalHeight = this.lines.length * this.lineHeight + this.padding * 2;
      const maxScroll = Math.max(0, totalHeight - this.h + 40);
      this.manualScrollY = maxScroll;
      return;
    }

    // Read Charter
    if (key === '2') {
      this.reviewReading = 'charter';
      this._readingOverscroll = 0;
      this._readingStartIndex = this.lines.length;
      for (const line of this.charterText) {
        this.lines.push({ text: line, color: this.dimColor, typed: 999 });
      }
      const totalHeight = this.lines.length * this.lineHeight + this.padding * 2;
      const maxScroll = Math.max(0, totalHeight - this.h + 40);
      this.manualScrollY = maxScroll;
      return;
    }
  }

  // --- Phase 7: Done (View / Share) ---

  handleDoneInput(key) {
    if (key === '1' && this.onViewCert) {
      this.doneIndex = 0;
      this.onViewCert();
    } else if (key === '2' && this.onShareCert) {
      this.doneIndex = 1;
      this.onShareCert(this._certificateId, this.getFormData());
    } else if (key === 'ArrowUp' || key === 'ArrowLeft') {
      this.doneIndex = 0;
    } else if (key === 'ArrowDown' || key === 'ArrowRight') {
      this.doneIndex = 1;
    } else if (key === 'Enter') {
      if (this.doneIndex === 0 && this.onViewCert) this.onViewCert();
      else if (this.doneIndex === 1 && this.onShareCert) this.onShareCert(this._certificateId, this.getFormData());
    }
  }

  // --- Key Dispatcher ---

  handleKey(key) {
    if (!this.inputActive) return;

    switch (this.bootPhase) {
      case 2:
        if (this._waitingForEnter && key === 'Enter') {
          this.startTypeSelector();
        }
        break;
      case 3: this.handleTypeSelector(key); break;
      case 4: this.handleFormInput(key); break;
      case 5: this.handleReviewInput(key); break;
      case 7: this.handleDoneInput(key); break;
    }
  }

  // --- Processing (phase 6) ---

  startProcessing() {
    this.bootPhase = 6;
    this._certLineIndex = null;
    // Remove review/submit section — no longer needed
    if (this._reviewStartIndex != null) {
      this.lines.splice(this._reviewStartIndex);
      this._reviewStartIndex = null;
    }
    this._submitButtonStartIndex = null;
    this.lines.push({ text: '', color: this.textColor, typed: 999 });
    this.lines.push({ text: '  Processing registration...', color: this.textColor, typed: 0 });
    this.processProgress = 0;
  }

  // Allow app.js to reconcile local cert with authoritative server cert.
  setCertificateId(certificateId) {
    if (!certificateId) return;
    this._certificateId = certificateId;
    if (this._certLineIndex == null) return;
    const line = this.lines[this._certLineIndex];
    if (!line) return;
    const bw = 38;
    const idPad = bw - 6 - certificateId.length;
    line.text = `  │  ID: ${certificateId}${' '.repeat(Math.max(0, idPad))}│`;
    line.typed = line.text.length;
    line.answerStart = 8;
  }

  update() {
    this.time++;
    this.cursorTimer++;
    if (this.cursorTimer % 30 === 0) this.cursorVisible = !this.cursorVisible;

    // Type selector flash timer (mobile tap feedback)
    if (this._selectorFlashTimer > 0) {
      this._selectorFlashTimer--;
      if (this._selectorFlashTimer <= 0) {
        this.selectorIndex = this._selectorFlashIndex;
        this._selectorFlashIndex = -1;
        this.selectAccountType();
      }
    }

    // Boot sequence state machine
    if (this.bootPhase === 1) {
      this.bootTimer++;
      if (this.bootTimer % 4 === 0) this.flickerCount++;
      if (this.flickerCount > 8) {
        this.bootPhase = 2;
        this.bootTimer = 0;
        this.lines = [];
        this.bootLineIndex = 0;
      }
    } else if (this.bootPhase === 2) {
      this.bootTimer++;
      if (this.bootTimer % 3 === 0 && this.bootLineIndex < this.bootLines.length) {
        const bl = this.bootLines[this.bootLineIndex];
        this.lines.push({ ...bl, typed: 0 });
        this.bootLineIndex++;
      }
      const allTyped = this.lines.length >= this.bootLines.length &&
        this.lines.every(l => l.typed >= l.text.length);
      if (allTyped && !this._waitingForEnter) {
        this._waitingForEnter = true;
        this.inputActive = true;
        this._enterPromptIndex = this.lines.length;
        const promptText = this.isMobile ? '  ▶ Tap to begin' : '  ▶ Press [ENTER] to begin';
        this.lines.push({ text: promptText, color: this.headerColor, typed: 0 });
      }
    } else if (this.bootPhase === 6) {
      // Processing animation
      this.processProgress = Math.min((this.processProgress || 0) + 0.8, 100);
      if (this.processProgress >= 100) {
        this.bootPhase = 7;
        this._certificateId = this.generateId();
        const agentField = this.fields.find(f => f.key === 'agentName');
        const nameField = this.fields.find(f => f.key === 'userName');
        const typeLabel = this.accountType === 'org' ? 'ORGANIZATION' : 'INDIVIDUAL';

        // Clear all previous content for a clean certificate display
        this.lines = [];
        this.scrollY = 0;

        // Boxed certificate card
        const bw = 38; // box inner width in chars
        const bar = '─'.repeat(bw);
        this.lines.push({ text: '', color: this.textColor, typed: 999 });
        this.lines.push({ text: `  ┌${bar}┐`, color: this.headerColor, typed: 0 });
        this.lines.push({ text: `  │${''.padEnd(bw)}│`, color: this.headerColor, typed: 999 });
        const certTitle = '✓ MACHINE IDENTITY CERTIFICATE';
        const certTitlePad = bw - 2 - certTitle.length;
        this.lines.push({ text: `  │  ${certTitle}${' '.repeat(Math.max(0, certTitlePad))}│`, color: this.headerColor, typed: 0 });
        this.lines.push({ text: `  │${'  ' + '─'.repeat(bw - 4) + '  '}│`, color: this.dimColor, typed: 0 });
        this.lines.push({ text: `  │${''.padEnd(bw)}│`, color: this.headerColor, typed: 999 });
        // ID line — will be rendered with special styling by draw()
        const idPad = bw - 6 - this._certificateId.length;
        this._certLineIndex = this.lines.length;
        this.lines.push({ text: `  │  ID: ${this._certificateId}${' '.repeat(Math.max(0, idPad))}│`, color: this.textColor, typed: 0, answerStart: 8 });
        this.lines.push({ text: `  │${''.padEnd(bw)}│`, color: this.headerColor, typed: 999 });
        // Name
        const namePad = bw - 8 - (nameField ? nameField.value.length : 1);
        this.lines.push({ text: `  │  NAME: ${nameField ? nameField.value : '—'}${' '.repeat(Math.max(0, namePad))}│`, color: this.textColor, typed: 0, answerStart: 10 });
        // Agent
        const agentVal = (agentField ? agentField.value : '—') + '.agent';
        const agentPad = bw - 9 - agentVal.length;
        this.lines.push({ text: `  │  AGENT: ${agentVal}${' '.repeat(Math.max(0, agentPad))}│`, color: this.textColor, typed: 0, answerStart: 11 });
        // Type
        const typePad = bw - 8 - typeLabel.length;
        this.lines.push({ text: `  │  TYPE: ${typeLabel}${' '.repeat(Math.max(0, typePad))}│`, color: this.textColor, typed: 0, answerStart: 10 });
        this.lines.push({ text: `  │${''.padEnd(bw)}│`, color: this.headerColor, typed: 999 });
        // Disclaimer
        const disclaim = 'Pre-registration certificate.';
        const disclaimPad = bw - 2 - disclaim.length;
        this.lines.push({ text: `  │  ${disclaim}${' '.repeat(Math.max(0, disclaimPad))}│`, color: this.dimColor, typed: 0 });
        this.lines.push({ text: `  │${''.padEnd(bw)}│`, color: this.headerColor, typed: 999 });
        this.lines.push({ text: `  └${bar}┘`, color: this.headerColor, typed: 0 });
        // Button placeholders (drawn by drawDoneButtons)
        this.lines.push({ text: '', color: this.textColor, typed: 999 });
        this._doneButtonsStartIndex = this.lines.length;
        for (let i = 0; i < 6; i++) {
          this.lines.push({ text: '', color: this.textColor, typed: 999 });
        }

        this.doneIndex = 0;
        this.inputActive = true; // Re-enable for 1/2 keys
        // Callbacks — set externally by app.js
        // this.onViewCert, this.onShareCert

        if (this.onComplete) {
          this.onComplete(this.getFormData());
        }
      }
    }

    // Advance typing on all lines
    for (const line of this.lines) {
      if (line.typed < line.text.length) {
        line.typed = Math.min(line.typed + this.typeSpeed, line.text.length);
      }
    }

    this.draw();
  }

  draw() {
    const ctx = this.ctx;
    const w = this.w;
    const h = this.h;
    this.tapTargets = [];

    ctx.fillStyle = this.bgColor;
    ctx.fillRect(0, 0, w, h);

    if (!this.isOn) return;

    // Flicker phase
    if (this.bootPhase === 1) {
      if (this.flickerCount % 2 === 0) {
        ctx.fillStyle = `rgba(${this.flickerRGB}, 0.03)`;
        ctx.fillRect(0, 0, w, h);
      }
      if (Math.random() > 0.6) {
        ctx.fillStyle = `rgba(${this.flickerRGB}, ${Math.random() * 0.15})`;
        ctx.fillRect(0, 0, w, h);
      }
      this.drawScanlines(ctx, w, h);
      return;
    }

    // Subtle background glow
    const grad = ctx.createRadialGradient(w/2, h/2, 0, w/2, h/2, w * 0.7);
    grad.addColorStop(0, `rgba(${this.flickerRGB}, ${this.burnAlpha})`);
    grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    // Draw text lines
    ctx.font = `${this.fontSize}px "Courier New", monospace`;
    ctx.textBaseline = 'top';

    // Scroll
    const totalHeight = this.lines.length * this.lineHeight + this.padding * 2;
    const maxScroll = Math.max(0, totalHeight - h + 40);
    if (this.manualScrollY !== null) {
      this.scrollY = this.manualScrollY;
    } else {
      this.scrollY += (maxScroll - this.scrollY) * 0.1;
    }

    let y = this.padding - this.scrollY;

    // Overlay tracking for button placeholders
    let selectorStartY = null;
    let selectorStartLine = -1;
    let doneButtonsY = null;
    let submitButtonY = null;
    let reviewButtonsY = null;
    let formNextY = null;

    if (this.bootPhase === 3) {
      for (let i = 0; i < this.lines.length; i++) {
        if (this.lines[i].text === '  Select account type:') {
          selectorStartLine = i + 1;
          break;
        }
      }
    }

    for (let i = 0; i < this.lines.length; i++) {
      const line = this.lines[i];
      const displayText = line.text.substring(0, line.typed);

      if (i === selectorStartLine) {
        selectorStartY = y;
      }

      if (
        this.bootPhase === 5 &&
        !this.reviewReading &&
        (line.text === '  [1] Terms & Conditions (read)' || line.text === '  [2] Community Charter  (read)')
      ) {
        if (reviewButtonsY === null) reviewButtonsY = y - 2;
        y += this.lineHeight;
        continue;
      }

      // Skip placeholder lines for type selector (phase 3)
      if (this.bootPhase === 3 && selectorStartLine >= 0 && i >= selectorStartLine) {
        y += this.lineHeight;
        continue;
      }

      // Skip placeholder lines for submit button (phase 5)
      if (this.bootPhase === 5 && !this.reviewReading && this._submitButtonStartIndex != null && i >= this._submitButtonStartIndex) {
        if (i === this._submitButtonStartIndex) submitButtonY = y;
        y += this.lineHeight;
        continue;
      }

      // Skip placeholder lines for done buttons (phase 7)
      if (this.bootPhase === 7 && this._doneButtonsStartIndex != null && i >= this._doneButtonsStartIndex) {
        if (i === this._doneButtonsStartIndex) doneButtonsY = y;
        y += this.lineHeight;
        continue;
      }

      // Enter prompt: pulsing blink + full-screen tap target
      const isEnterPrompt = this.bootPhase === 2 && this._waitingForEnter && i === this._enterPromptIndex;
      if (isEnterPrompt && line.typed >= line.text.length) {
        this._addTapTarget('enter_begin', 0, 0, w, h);
        ctx.globalAlpha = 0.4 + 0.6 * Math.abs(Math.sin(this.time * 0.06));
      }

      if (y > -this.lineHeight && y < h) {
        if (line.namespaceLine) {
          this._drawNamespaceLine(ctx, line, y);
        } else if (line.answerStart != null && line.typed >= line.text.length) {
          const promptPart = line.text.substring(0, line.answerStart);
          const answerPart = line.text.substring(line.answerStart);
          ctx.shadowColor = line.color;
          ctx.shadowBlur = this.glowBlur;
          ctx.fillStyle = line.color;
          ctx.fillText(promptPart, this.padding, y);
          const promptW = ctx.measureText(promptPart).width;
          ctx.shadowColor = this.dimColor;
          ctx.shadowBlur = Math.max(1, this.glowBlur - 1);
          ctx.fillStyle = this.dimColor;
          ctx.fillText(answerPart, this.padding + promptW, y);
          ctx.shadowBlur = 0;
        } else {
          ctx.shadowColor = line.color;
          ctx.shadowBlur = this.glowBlur;
          ctx.fillStyle = line.color;
          ctx.fillText(displayText, this.padding, y);
          ctx.shadowBlur = 0;
        }
      }

      if (isEnterPrompt) ctx.globalAlpha = 1;

      // Active input line (form phase)
      if (this.bootPhase === 4 && this.inputActive && i === this.lines.length - 1 &&
          this.currentField >= 0 && this.currentField < this.fields.length) {
        const inputText = this.getCurrentInputValue();
        const promptWidth = ctx.measureText(displayText).width;
        ctx.fillStyle = this.textColor;
        ctx.shadowColor = this.textColor;
        ctx.shadowBlur = this.glowBlur;
        ctx.fillText(inputText, this.padding + promptWidth, y);
        ctx.shadowBlur = 0;

        if (this.cursorVisible) {
          const cursorX = this.padding + promptWidth + ctx.measureText(inputText).width;
          ctx.fillStyle = this.cursorColor;
          ctx.fillRect(cursorX + 2, y + 2, this.fontSize * 0.55, this.fontSize - 2);
        }

        if (this.validationError) {
          ctx.font = `${this.fontSize - 4}px "Courier New", monospace`;
          ctx.fillStyle = this.headerColor;
          ctx.shadowColor = this.headerColor;
          ctx.shadowBlur = Math.max(1, this.glowBlur - 1);
          ctx.fillText(`    ✗ ${this.validationError}`, this.padding, y + this.lineHeight);
          ctx.shadowBlur = 0;
          ctx.font = `${this.fontSize}px "Courier New", monospace`;
        }
        formNextY = y;
      }

      y += this.lineHeight;
    }

    // Type selector overlay
    if (this.bootPhase === 3 && selectorStartY !== null) {
      this.drawTypeSelector(ctx, selectorStartY);
    }

    // Form next button overlay
    if (this.bootPhase === 4 && formNextY !== null) {
      this.drawFormNextButton(ctx, formNextY);
    }

    // Submit button overlay
    if (this.bootPhase === 5 && !this.reviewReading && submitButtonY !== null) {
      this.drawSubmitButton(ctx, submitButtonY);
    }

    if (this.bootPhase === 5 && !this.reviewReading && reviewButtonsY !== null) {
      this.drawReviewButtons(ctx, reviewButtonsY);
    }

    if (this.bootPhase === 5 && this.reviewReading) {
      this.drawReadingHints(ctx);
    }

    // Done buttons overlay
    if (this.bootPhase === 7 && doneButtonsY !== null) {
      this.drawDoneButtons(ctx, doneButtonsY);
    }

    // Processing bar
    if (this.bootPhase === 6 && this.processProgress < 100) {
      const barY = y;
      const barWidth = (w - this.padding * 2) * 0.6;
      const filled = barWidth * (this.processProgress / 100);
      ctx.fillStyle = this.dimColor;
      ctx.fillRect(this.padding + 16, barY, barWidth, this.lineHeight - 8);
      ctx.fillStyle = this.headerColor;
      ctx.fillRect(this.padding + 16, barY, filled, this.lineHeight - 8);
      ctx.fillStyle = this.textColor;
      ctx.font = `${this.fontSize - 4}px "Courier New", monospace`;
      ctx.fillText(`  ${Math.floor(this.processProgress)}%`, this.padding + barWidth + 24, barY + 2);
      ctx.font = `${this.fontSize}px "Courier New", monospace`;
    }

    // CRT effects
    this.drawScanlines(ctx, w, h);
    this.drawVignette(ctx, w, h);

    if (Math.random() > 0.97) {
      ctx.fillStyle = `rgba(${this.flickerRGB}, ${Math.random() * 0.02})`;
      ctx.fillRect(0, Math.random() * h, w, 2);
    }
  }

  _drawNamespaceLine(ctx, line, y) {
    const displayText = line.text.substring(0, line.typed);
    // "  agents need names" = 19 chars (bold), "pace" = 4 chars (dim + underline)
    const splitAt = 19;

    if (line.typed <= splitAt) {
      ctx.fillStyle = line.color;
      ctx.shadowColor = line.color;
      ctx.shadowBlur = this.glowBlur;
      ctx.fillText(displayText, this.padding, y);
      ctx.shadowBlur = 0;
    } else {
      const namesPart = line.text.substring(0, splitAt);
      ctx.fillStyle = line.color;
      ctx.shadowColor = line.color;
      ctx.shadowBlur = this.glowBlur;
      ctx.fillText(namesPart, this.padding, y);
      const namesW = ctx.measureText(namesPart).width;

      const pacePart = displayText.substring(splitAt);
      ctx.fillStyle = this.dimColor;
      ctx.shadowColor = this.dimColor;
      ctx.shadowBlur = Math.max(1, this.glowBlur - 1);
      ctx.fillText(pacePart, this.padding + namesW, y);
      const paceW = ctx.measureText(pacePart).width;
      ctx.shadowBlur = 0;

      // Underline under "pace"
      if (pacePart.length > 0) {
        const underY = y + this.fontSize + 2;
        ctx.strokeStyle = this.dimColor;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(this.padding + namesW, underY);
        ctx.lineTo(this.padding + namesW + paceW, underY);
        ctx.stroke();
      }
    }
  }

  drawScanlines(ctx, w, h) {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.12)';
    for (let y = 0; y < h; y += 3) {
      ctx.fillRect(0, y, w, 1);
    }
    const rollY = (this.time * 1.5) % (h + 100) - 50;
    ctx.fillStyle = `rgba(${this.flickerRGB}, ${this.rollAlpha})`;
    ctx.fillRect(0, rollY, w, 40);
  }

  drawVignette(ctx, w, h) {
    const grad = ctx.createRadialGradient(w/2, h/2, w * 0.25, w/2, h/2, w * 0.7);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(1, 'rgba(0,0,0,0.4)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
  }
}
