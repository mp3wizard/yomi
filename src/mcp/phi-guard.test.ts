import { expect, test } from 'bun:test'
import { createPhiAccumulator, maskInto } from './phi-guard.js'

// 4111 1111 1111 1111 is the standard Luhn-valid test card number.
const CARD = '4111111111111111'

test('masks a bare Luhn-valid card', () => {
  const acc = createPhiAccumulator()
  const out = maskInto(acc, `card ${CARD} thanks`)
  expect(out).not.toContain(CARD)
  expect(acc.types.has('card')).toBe(true)
})

test('masks a card embedded in a longer digit run', () => {
  // Card + expiry/CVV written next to it: the whole run is not Luhn-valid, so
  // only a check of the spans inside it catches the card. The audit's
  // payloads, plus an unseparated run longer than any card.
  for (const text of [
    '4111 1111 1111 1111 12/26 cvv 123',
    `${CARD} 12`,
    `order 12 ${CARD}`,
    '4111-1111-1111-1111-12-25',
    `${CARD}12345`,
  ]) {
    const acc = createPhiAccumulator()
    const out = maskInto(acc, `pay with ${text} ok`)
    expect(out.replace(/\D/g, '')).not.toContain(CARD)
    expect(acc.count).toBe(1)
  }
})

test('leaves ordinary numbers alone', () => {
  // 1234 5678 9012 3456 fails Luhn on every separator-aligned span; scanning
  // every raw window inside it would have masked it.
  for (const text of [
    'the Taitung meeting is at 3pm, room 1203',
    'tracking 1234 5678 9012 3456',
  ]) {
    const acc = createPhiAccumulator()
    expect(maskInto(acc, text)).toBe(text)
    expect(acc.count).toBe(0)
  }
})
