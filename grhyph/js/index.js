
import { hyphenate } from './quickSynizesis.js';

const args = process.argv.slice(2);
let phrase = '';
let separator = '\u00AD';

const separatorIndex = args.findIndex(arg => arg === '--separator');

if (separatorIndex !== -1) {
  if (separatorIndex + 1 < args.length) {
    separator = args[separatorIndex + 1];
    args.splice(separatorIndex, 2);
  } else {
    console.error('Error: --separator flag requires a value.');
    process.exit(1);
  }
}

phrase = args.join(' ');

if (!phrase) {
  console.log('Please provide a word or phrase to hyphenate.');
  console.log('Usage: node index.js [--separator <sep>] "<phrase>"');
  process.exit(1);
}

const hyphenationOptions = {
  quickSynizesis: true,
  separator,
};

const hyphenatedPhrase = phrase
  .split(' ')
  .map(word => hyphenate(word, hyphenationOptions))
  .join(' ');

console.log(hyphenatedPhrase);
