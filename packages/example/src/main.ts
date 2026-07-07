// 入口：引导 agent + 把按钮点击派发到 actions。
import { actions } from './actions';
import { bootstrapFarview } from './farview';

function setState(text: string): void {
  const el = document.getElementById('agentState');
  if (el) el.textContent = text;
}

bootstrapFarview()
  .then(setState)
  .catch((err: unknown) => setState(`加载失败：${err instanceof Error ? err.message : err}`));

document.body.addEventListener('click', (e) => {
  const target = e.target;
  if (!(target instanceof HTMLElement)) return;
  const act = target.dataset.act;
  if (act && act in actions) actions[act]();
});
