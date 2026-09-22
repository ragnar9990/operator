const agent = require('./agent');
const desktop = require('./desktop');
const path = require('path');

const task = process.argv[2] || 'Take a screenshot of display 1 and tell me which application is in the foreground.';

agent.runTask(task, {
  userDataDir: path.join(require('os').tmpdir(), 'operator-smoke-profile'),
  abortController: new AbortController(),
  onEvent: (e) => {
    if (e.type === 'tool') console.log('  TOOL  ', e.name, JSON.stringify(e.input).slice(0, 140));
    else if (e.type === 'assistant') console.log('  SAY   ', e.text.slice(0, 400));
    // text is null when the result only repeats what was already said
    else if (e.type === 'done') console.log('  DONE  ', (e.text || '(nothing further)').slice(0, 600));
    else console.log('  ' + e.type, JSON.stringify(e).slice(0, 200));
  },
}).then(() => { desktop.stop(); process.exit(0); })
  .catch((err) => { console.error('FAILED:', err.message); desktop.stop(); process.exit(1); });
