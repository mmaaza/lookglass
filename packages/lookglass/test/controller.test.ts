import { describe, expect, it } from 'vitest';
import { BaseController } from '../src/core/controller.js';
import { NO_CAPABILITIES } from '../src/types.js';

const controller = (pageCount = 100) =>
  new BaseController({ pageCount, capabilities: { ...NO_CAPABILITIES, pages: true, zoom: true } });

describe('BaseController page syncing', () => {
  it('marks a page reached by scrolling so the surface does not scroll again', () => {
    const c = controller();
    c.syncPage(5);
    expect(c.getState().page).toBe(5);
    expect(c.pageFromScroll()).toBe(true);
  });

  it('treats explicit navigation as a request to move the view', () => {
    const c = controller();
    c.goToPage(40);
    expect(c.pageFromScroll()).toBe(false);
  });

  it('moves the view when navigating back to a page last reached by scrolling', () => {
    // Regression: scroll to 5, jump to 9, jump back to 5. The second jump used
    // to look like scroll-originated and left the view on page 9.
    const c = controller();
    c.syncPage(5);
    c.goToPage(9);
    c.goToPage(5);
    expect(c.getState().page).toBe(5);
    expect(c.pageFromScroll()).toBe(false);
  });

  it('clamps synced pages to the document', () => {
    const c = controller(10);
    c.syncPage(50);
    expect(c.getState().page).toBe(10);
  });

  it('reports an effective zoom without leaving fit mode', () => {
    const c = controller();
    c.setFit('width');
    c.setEffectiveZoom(1.58);
    expect(c.getState().viewport).toMatchObject({ fit: 'width', zoom: 1.58 });
  });

  it('leaves fit mode on an explicit zoom', () => {
    const c = controller();
    c.setFit('width');
    c.setZoom(2);
    expect(c.getState().viewport).toMatchObject({ fit: 'none', zoom: 2 });
  });
});
