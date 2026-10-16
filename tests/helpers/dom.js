/**
 * Minimal DOM stub for node-environment unit tests.
 *
 * vitest runs in the 'node' environment, so the radio layer's DOM access is
 * faked here — deliberately tiny, covering only what ptt/remote-audio touch.
 */

class FakeClassList {
  #set = new Set();
  add(...names) { names.forEach((n) => this.#set.add(n)); }
  remove(...names) { names.forEach((n) => this.#set.delete(n)); }
  contains(name) { return this.#set.has(name); }
  toggle(name, force) {
    const on = force ?? !this.#set.has(name);
    if (on) this.#set.add(name); else this.#set.delete(name);
    return on;
  }
  get value() { return [...this.#set].join(' '); }
}

class FakeElement {
  constructor(tag = 'div', attrs = {}) {
    this.tagName = tag.toUpperCase();
    this.classList = new FakeClassList();
    this.dataset = {};
    this.style = {};
    this.children = [];
    this.attrs = {};
    this.listeners = new Map();
    this.textContent = '';
    this.srcObject = null;
    this.volume = 1;
    this.autoplay = false;
    for (const [k, v] of Object.entries(attrs)) {
      if (k.startsWith('data-')) this.dataset[k.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = v;
      else this.attrs[k] = v;
    }
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(type, list.filter((f) => f !== fn));
  }
  /** Test helper: fire a listener. */
  fire(type, event = {}) {
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }
  setAttribute(k, v) { this.attrs[k] = v; }
  getAttribute(k) { return this.attrs[k]; }
  removeAttribute(k) { delete this.attrs[k]; }
  focus() { this.focused = true; }
  setPointerCapture() {}
  releasePointerCapture() {}
  append(...nodes) { for (const n of nodes) this.appendChild(n); }
  appendChild(node) { this.children.push(node); node.__parent = this; return node; }
  remove() {
    this.removed = true;
    const p = this.__parent;
    if (p) p.children = p.children.filter((c) => c !== this);
  }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  play() { return this.playImpl ? this.playImpl() : Promise.resolve(); }
}

class FakeAudio extends FakeElement {
  constructor() { super('audio'); this.playImpl = () => Promise.resolve(); }
}

/**
 * Install the stub globally. `ids` maps element id -> FakeElement.
 * Returns a handle with the created document/window and a restore().
 */
export function installDom({ ids = {}, audioSinks = false } = {}) {
  const elements = new Map(Object.entries(ids));

  const document = {
    body: new FakeElement('body'),
    hidden: false,
    getElementById: (id) => elements.get(id) ?? null,
    querySelector: () => null,
    querySelectorAll: (sel) => {
      if (sel === 'audio[data-remote]') {
        /* created sinks are appended to <body>, not looked up by id */
        return document.body.children.filter((e) => e.tagName === 'AUDIO');
      }
      return [];
    },
    createElement: (tag) => (tag === 'audio' ? new FakeAudio() : new FakeElement(tag)),
    addEventListener: () => {},
    removeEventListener: () => {},
    fonts: { ready: Promise.resolve() },
  };
  if (audioSinks) document.__audioSinks = [];

  const window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    AudioContext: undefined,
  };

  /* headless node has no frame loop — the render loop schedules rAF */
  let rafHandle = 0;
  const frames = [];
  globalThis.requestAnimationFrame = (cb) => { frames.push(cb); rafHandle++; return rafHandle; };
  globalThis.cancelAnimationFrame = () => { rafHandle = 0; };

  const previousDoc = globalThis.document;
  const previousWin = globalThis.window;
  globalThis.document = document;
  globalThis.window = window;

  return {
    document,
    window,
    elements,
    /** Run any frames the loop scheduled (rAF is a no-op stub otherwise). */
    flushFrames() {
      const pending = [...frames];
      frames.length = 0;
      for (const cb of pending) cb(performance.now());
    },
    restore() {
      if (previousDoc === undefined) delete globalThis.document; else globalThis.document = previousDoc;
      if (previousWin === undefined) delete globalThis.window; else globalThis.window = previousWin;
    },
  };
}

export { FakeElement, FakeAudio, FakeClassList };