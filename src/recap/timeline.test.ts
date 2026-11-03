import { describe, expect, it } from 'vitest';
import { reviewedGame } from '../../tests/support/recap.js';
import { musicScore } from './music.js';
import { planRecap, resultCaption, sceneAt } from './timeline.js';

describe('recap composition', () => {
  it('keeps a full replay legal and gives the saved result the final scene', () => {
    const review = reviewedGame();
    const timeline = planRecap(review);
    expect(timeline.scenes.filter(scene => scene.kind === 'move').map(scene => scene.move!.uci)).toEqual(['f2f3', 'e7e5', 'g2g4', 'd8h4']);
    expect(timeline.scenes.filter(scene => scene.kind === 'move').every(scene => !scene.jump)).toBe(true);
    expect(sceneAt(timeline, timeline.duration).caption).toBe('Black wins by checkmate');
    expect(timeline.scenes.at(-1)!.fen).toBe(review.moves.at(-1)!.fenAfter);
    expect(timeline.scenes.every(scene => Number.isInteger(scene.start * timeline.bpm / 60))).toBe(true);
  });
  it('never invents checkmate for resignation or a terminal game with no moves', () => {
    const review = reviewedGame([]);
    expect(resultCaption(review)).toBe('Black wins by resignation');
    expect(planRecap(review).scenes.map(scene => scene.kind)).toEqual(['intro', 'ending']);
  });
  it('marks skipped positions and retains the actual ending in long highlights', () => {
    const sans: string[] = [];
    for (let i = 0; i < 22; i++) sans.push('Nf3', 'Nf6', 'Ng1', 'Ng8');
    const review = reviewedGame(sans);
    const timeline = planRecap(review, 'highlights');
    const moves = timeline.scenes.filter(scene => scene.kind === 'move');
    expect(moves.length).toBeLessThan(review.moves.length);
    expect(moves.some(scene => scene.jump)).toBe(true);
    expect(moves.at(-1)!.move!.ply).toBe(review.moves.length);
    expect(moves.map(scene => scene.move!.ply)).toEqual([...moves.map(scene => scene.move!.ply)].sort((a, b) => a - b));
  });
  it('generates bounded, repeatable music events on the same timeline', () => {
    const timeline = planRecap(reviewedGame());
    const first = musicScore(timeline);
    expect(musicScore(timeline)).toEqual(first);
    expect(first.every(note => note.start >= 0 && note.duration > 0 && note.start + note.duration <= timeline.duration + 0.000001)).toBe(true);
    expect(first.some(note => note.start >= timeline.scenes.at(-1)!.start)).toBe(true);
  });
});
