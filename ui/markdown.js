/* Markdown for the coding replies — enough of it to read what Claude Code
 * writes: headings, lists (nested, numbered, task lists), tables, quotes,
 * rules, fenced code with highlighting, and inline code, bold, italics,
 * strikethrough and links.
 *
 * Safe by construction: every piece of text is escaped before any tag is
 * added, and the only tags that can come out are the ones written here. A
 * reply can never inject markup, however it is worded.
 */

(function () {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // Fence languages, mapped onto the editor's highlighters.
  const LANG = {
    js: 'js', javascript: 'js', jsx: 'js', ts: 'js', typescript: 'js', tsx: 'js', mjs: 'js', cjs: 'js', node: 'js',
    json: 'json', jsonc: 'json',
    html: 'html', xml: 'html', svg: 'html', vue: 'html', svelte: 'html',
    css: 'css', scss: 'css', less: 'css',
    py: 'py', python: 'py',
    sh: 'sh', bash: 'sh', shell: 'sh', zsh: 'sh', powershell: 'sh', ps1: 'sh', pwsh: 'sh', cmd: 'sh', bat: 'sh', console: 'sh', terminal: 'sh',
    md: 'md', markdown: 'md',
    yaml: 'conf', yml: 'conf', toml: 'conf', ini: 'conf', env: 'conf', dotenv: 'conf',
    c: 'c', cpp: 'c', 'c++': 'c', cs: 'c', csharp: 'c', java: 'c', go: 'c', rust: 'c', rs: 'c', php: 'c',
    ruby: 'c', rb: 'c', sql: 'c', kotlin: 'c', swift: 'c', dart: 'c', lua: 'c',
  };

  // Inline code that names a file or a path, so it can be clicked open.
  const PATHISH = /^(?:[A-Za-z]:[\\/]|~[\\/]|\.{0,2}[\\/])?(?:[\w@.+-]+[\\/])*[\w@+-][\w@.+-]*\.[A-Za-z0-9]{1,8}$|^(?:[A-Za-z]:)?(?:[\w@.+-]*[\\/])+[\w@.+-]*[\\/]?$/;

  function inline(src) {
    const codes = [];
    let s = String(src).replace(/`([^`\n]+)`/g, (_, c) => {
      codes.push(c);
      return '\u0000' + (codes.length - 1) + '\u0000';
    });
    s = esc(s);
    s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, t, u) => `<a href="#" data-url="${u}">${t}</a>`);
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)"]+[^\s<)".,;:!?])/g, (_, pre, u) => `${pre}<a href="#" data-url="${u}">${u}</a>`);
    s = s.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^\w])__([^_\n]+?)__(?!\w)/g, '$1<strong>$2</strong>');
    s = s.replace(/(^|[^*\w])\*([^*\s][^*\n]*?)\*(?![*\w])/g, '$1<em>$2</em>');
    s = s.replace(/(^|[^\w])_([^_\s][^_\n]*?)_(?!\w)/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
    s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => {
      const c = codes[Number(i)];
      return PATHISH.test(c.trim()) && !/\s/.test(c.trim())
        ? `<code class="md-path" title="Open in the editor">${esc(c)}</code>`
        : `<code>${esc(c)}</code>`;
    });
    return s;
  }

  function codeBlock(body, lang) {
    const key = LANG[String(lang || '').toLowerCase()];
    const hl = window.CodeEditor && key ? window.CodeEditor.highlight(body, key) : esc(body);
    return `<div class="md-code"><div class="md-code-head"><span>${esc(lang || 'text')}</span>` +
      `<button class="md-copy" type="button">Copy</button></div><pre><code>${hl}</code></pre></div>`;
  }

  const LIST = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;
  const cells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

  function list(lines, i) {
    const items = [];
    while (i < lines.length) {
      const m = lines[i].match(LIST);
      if (m) {
        items.push({ ind: m[1].replace(/\t/g, '  ').length, ord: /\d/.test(m[2]), start: parseInt(m[2], 10) || 1, text: m[3] });
        i++;
      } else if (items.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*```/.test(lines[i])) {
        items[items.length - 1].text += '\n' + lines[i].trim();
        i++;
      } else break;
    }
    let html = '';
    const stack = [];
    for (const it of items) {
      while (stack.length > 1 && it.ind < stack[stack.length - 1].ind) html += '</li></' + stack.pop().tag + '>';
      const tag = it.ord ? 'ol' : 'ul';
      const open = () => {
        stack.push({ ind: it.ind, tag });
        html += `<${tag}${it.ord && it.start !== 1 ? ` start="${it.start}"` : ''}>`;
      };
      const top = stack[stack.length - 1];
      if (!top || it.ind > top.ind) open();
      // Bullets straight after numbers (or the reverse) are a new list.
      else if (top.tag !== tag) { html += '</li></' + stack.pop().tag + '>'; open(); }
      else html += '</li>';
      let text = inline(it.text).replace(/\n/g, '<br>');
      const task = it.text.match(/^\[( |x|X)\]\s+/);
      if (task) {
        text = `<span class="md-task${task[1] === ' ' ? '' : ' done'}"></span>` + inline(it.text.slice(task[0].length)).replace(/\n/g, '<br>');
      }
      html += '<li>' + text;
    }
    while (stack.length) html += '</li></' + stack.pop().tag + '>';
    return [html, i];
  }

  function blocks(src) {
    const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let i = 0;
    const isStart = (l, next) =>
      /^\s*(```|~~~)/.test(l) || /^#{1,6}\s/.test(l) || /^\s*>/.test(l) || LIST.test(l) ||
      /^\s*([-*_])(\s*\1){2,}\s*$/.test(l) || (l.includes('|') && next !== undefined && /^\s*\|?\s*:?-{3,}/.test(next));

    while (i < lines.length) {
      const line = lines[i];

      const fence = line.match(/^\s*(```+|~~~+)\s*([^\s`]*)/);
      if (fence) {
        const mark = fence[1];
        const body = [];
        i++;
        while (i < lines.length && !lines[i].trim().startsWith(mark)) body.push(lines[i++]);
        i++;
        out.push(codeBlock(body.join('\n'), fence[2]));
        continue;
      }
      if (!line.trim()) { i++; continue; }

      const h = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
      if (h) {
        // A reply's "# Title" is a heading in a chat bubble, not a page title.
        const n = Math.min(6, h[1].length + 2);
        out.push(`<h${n}>${inline(h[2])}</h${n}>`);
        i++;
        continue;
      }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push('<hr />'); i++; continue; }

      if (/^\s*>/.test(line)) {
        const q = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ''));
        out.push('<blockquote>' + blocks(q.join('\n')) + '</blockquote>');
        continue;
      }

      if (line.includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1])) {
        const head = cells(line);
        const align = cells(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? 'center' : /-+:$/.test(c) ? 'right' : ''));
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
        const td = (tag, c, k) => `<${tag}${align[k] ? ` style="text-align:${align[k]}"` : ''}>${inline(c)}</${tag}>`;
        out.push('<div class="md-table"><table><thead><tr>' + head.map((c, k) => td('th', c, k)).join('') + '</tr></thead><tbody>' +
          rows.map((r) => '<tr>' + head.map((_, k) => td('td', r[k] || '', k)).join('') + '</tr>').join('') + '</tbody></table></div>');
        continue;
      }

      if (LIST.test(line)) {
        const [html, next] = list(lines, i);
        out.push(html);
        i = next;
        continue;
      }

      const para = [];
      while (i < lines.length && lines[i].trim() && !(para.length && isStart(lines[i], lines[i + 1]))) para.push(lines[i++]);
      out.push('<p>' + para.map(inline).join('<br>') + '</p>');
    }
    return out.join('');
  }

  window.Markdown = { render: blocks, inline };
})();
