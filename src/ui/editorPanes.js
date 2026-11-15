// The two editable panes (Original / Changed). Textareas are always visible
// and interactive on load. File drops and the file picker land here too.
import { copyText } from './dom.js';

const MAX_PASTE = 250 * 1024 * 1024; // hard ceiling, well above the 250 MB UI limit

export class Editors {
  constructor({ onInput, onFile, onCompare }) {
    this.panes = {
      a: this.bindPane('a', 'textA', onInput, onFile),
      b: this.bindPane('b', 'textB', onInput, onFile),
    };
    this.onCompareCb = onCompare;
    document.getElementById('compareBtn').addEventListener('click', () => onCompare());
  }

  bindPane(side, textareaId, onInput, onFile) {
    const pane = document.getElementById(side === 'a' ? 'epaneA' : 'epaneB');
    const ta = document.getElementById(textareaId);
    const name = pane.querySelector('.ename');

    ta.addEventListener('input', () => onInput(side, ta.value));
    // drop a text file straight onto a pane
    pane.addEventListener('dragover', (e) => { e.preventDefault(); pane.classList.add('is-drag'); });
    pane.addEventListener('dragleave', () => pane.classList.remove('is-drag'));
    pane.addEventListener('drop', (e) => {
      e.preventDefault();
      pane.classList.remove('is-drag');
      const f = e.dataTransfer?.files?.[0];
      if (f) onFile(side, f);
    });

    pane.querySelector(`[data-copy="${side}"]`).addEventListener('click', () => copyText(ta.value));
    pane.querySelector(`[data-paste="${side}"]`).addEventListener('click', async () => {
      try {
        const text = await navigator.clipboard.readText();
        ta.value = text;
        name.textContent = '';
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      } catch {
        // Clipboard read can be denied; focus so the user can paste manually.
        ta.focus();
      }
    });
    pane.querySelector(`[data-clear="${side}"]`).addEventListener('click', () => {
      ta.value = '';
      name.textContent = '';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    });
    pane.querySelector(`[data-open="${side}"]`).addEventListener('click', () => {
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.onchange = () => { if (inp.files[0]) onFile(side, inp.files[0]); };
      inp.click();
    });

    return { pane, ta, name };
  }

  value(side) { return this.panes[side].ta.value; }

  setValue(side, text, name = '') {
    const p = this.panes[side];
    p.ta.value = text.length > MAX_PASTE ? text.slice(0, MAX_PASTE) : text;
    p.name.textContent = name;
  }

  setWrap(on) {
    for (const side of ['a', 'b']) {
      const p = this.panes[side];
      p.ta.wrap = on ? 'soft' : 'off';
      p.pane.classList.toggle('is-wrap', !!on);
    }
  }

  setName(side, name) {
    this.panes[side].name.textContent = name;
  }

  hasAnyText() {
    return this.value('a').length > 0 || this.value('b').length > 0;
  }

  swap() {
    const a = this.value('a');
    const na = this.panes.a.name.textContent;
    this.setValue('a', this.value('b'), this.panes.b.name.textContent);
    this.setValue('b', a, na);
  }

  clear() {
    for (const side of ['a', 'b']) {
      const p = this.panes[side];
      p.ta.value = '';
      p.name.textContent = '';
    }
  }

  setRealtime(on) {
    document.getElementById('compareBtn').disabled = on;
    document.getElementById('compareBtn').title = on
      ? 'Real-time diffing is on — text is compared as you type'
      : 'Run the diff now (Ctrl/Cmd+Enter)';
  }

  focus(side) {
    this.panes[side].ta.focus();
  }
}