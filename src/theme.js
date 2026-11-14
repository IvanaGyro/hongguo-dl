// Light/dark theme switch. The choice is kept on this device only; with no
// saved choice the page follows the system setting (set inline in index.html).
const KEY = 'hongguo-dl-theme-v1';
const root = document.documentElement;
const button = document.getElementById('theme-toggle');
const meta = document.querySelector('meta[name="theme-color"]');
function apply(theme) {
  root.dataset.theme = theme;
  const next = theme === 'dark' ? '淺色' : '深色';
  button.setAttribute('aria-label', '切換為' + next + '主題');
  button.title = '切換為' + next + '主題';
  meta?.setAttribute('content', theme === 'dark' ? '#17100b' : '#fbfcf7');
}
apply(root.dataset.theme === 'light' ? 'light' : 'dark');
button.addEventListener('click', () => {
  const theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
  apply(theme);
  try { localStorage.setItem(KEY, theme); } catch { /* private mode */ }
});
