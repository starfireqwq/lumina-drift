import { isReducedMotion, subscribeMotionChange } from '../../theme/motion';

const STAGGER_MS = 55;

export function playWorkspaceEntrance(workspace: HTMLElement) {
  if (isReducedMotion() || typeof workspace.animate !== 'function') return;

  const animations: Animation[] = [];
  const reveal = (selector: string, x: number, y: number, delay: number, scale = 1) => {
    workspace.querySelectorAll<HTMLElement>(selector).forEach((part, index) => {
      const animation = part.animate([
        { opacity: 0, translate: `${x}px ${y}px`, scale },
        { opacity: 1, translate: `${-x * 0.15}px ${-y * 0.15}px`, scale: 1, offset: 0.77 },
        { opacity: 1, translate: '0px 0px', scale: 1 },
      ], {
        duration: 290,
        delay: delay + Math.min(index, 2) * STAGGER_MS,
        easing: 'cubic-bezier(.22, .8, .26, 1)',
        fill: 'backwards',
      });
      animation.id = 'atelier-workspace-entrance';
      animations.push(animation);
    });
  };

  reveal('[data-workspace-entry="options"]', 0, -9, 0);
  reveal('[data-workspace-entry="left-tools"]', -10, 0, STAGGER_MS);
  reveal('[data-workspace-entry="right-tools"]', 10, 0, STAGGER_MS);
  reveal('[data-dock-side="left"] [data-panel]', -12, 0, STAGGER_MS * 2);
  reveal('[data-dock-side="right"] [data-panel]', 12, 0, STAGGER_MS * 3);
  reveal('[data-dock-side="bottom"] [data-panel], [data-workspace-entry="mobile-tools"]', 0, 10, STAGGER_MS * 3);
  reveal('[data-float-group]', 0, 12, STAGGER_MS * 4, 0.98);

  const listeners = new AbortController();
  const stop = () => {
    listeners.abort();
    for (const animation of animations) animation.cancel();
  };
  const capture = { capture: true, signal: listeners.signal };
  window.addEventListener('pointerdown', stop, capture);
  window.addEventListener('keydown', stop, capture);
  const unsubscribeMotion = subscribeMotionChange(() => {
    if (isReducedMotion()) stop();
  });
  listeners.signal.addEventListener('abort', unsubscribeMotion, { once: true });
  void Promise.allSettled(animations.map((animation) => animation.finished)).then(() => listeners.abort());
  return stop;
}
