
import assert from 'assert';
import { hyphenate } from './quickSynizesis.js';

const testCases = [
  {
    word: 'αηδόνι',
    withSynizesis: 'αη-δό-νι',
    withoutSynizesis: 'α-η-δό-νι',
    description: 'Synizesis on "αη"',
  },
  {
    word: 'ποιότητα',
    withSynizesis: 'ποιό-τη-τα',
    withoutSynizesis: 'ποι-ό-τη-τα',
    description: 'Synizesis on "οι"',
  },
  {
    word: 'θέατρο',
    withSynizesis: 'θέ-α-τρο',
    withoutSynizesis: 'θέ-α-τρο',
    description: 'No synizesis on "εα"',
  },
  {
    word: 'γεια',
    withSynizesis: 'γεια',
    withoutSynizesis: 'γει-α',
    description: 'Synizesis on "ει"',
  },
  {
    word: 'γαιδαρος',
    withSynizesis: 'γαι-δα-ρος',
    withoutSynizesis: 'γαι-δα-ρος',
    description: '"αι" is parsed as a single vowel sound',
  },
  {
    word: 'γαϊδαρος',
    withSynizesis: 'γαϊ-δα-ρος',
    withoutSynizesis: 'γα-ϊ-δα-ρος',
    description: 'Synizesis on "αϊ"',
  },
];

testCases.forEach(({ word, withSynizesis, withoutSynizesis, description }) => {
  console.log(`Testing word: "${word}" (${description})`);

  const resultWithSynizesis = hyphenate(word, {
    quickSynizesis: true,
    separator: '-',
  });
  assert.strictEqual(
    resultWithSynizesis,
    withSynizesis,
    `  [FAIL] With synizesis: expected "${withSynizesis}", but got "${resultWithSynizesis}"`
  );
  console.log(`  [PASS] With synizesis: "${resultWithSynizesis}"`);

  const resultWithoutSynizesis = hyphenate(word, {
    quickSynizesis: false,
    separator: '-',
  });
  assert.strictEqual(
    resultWithoutSynizesis,
    withoutSynizesis,
    `  [FAIL] Without synizesis: expected "${withoutSynizesis}", but got "${resultWithoutSynizesis}"`
  );
  console.log(`  [PASS] Without synizesis: "${resultWithoutSynizesis}"`);
  console.log('---');
});

console.log('All tests passed!');
