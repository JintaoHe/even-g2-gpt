export type SimulatedLocation = {
  id: string;
  label: string;
  latitude: number;
  longitude: number;
  accuracy: number;
  timezone: string;
};

// Public landmark/city-center approximations for local development only. They are
// deliberately kept out of the production bundle and are not user location data.
export const LOCATION_PRESETS: readonly SimulatedLocation[] = [
  { id: 'east-village', label: 'Des Moines · East Village', latitude: 41.5898, longitude: -93.6121, accuracy: 15, timezone: 'America/Chicago' },
  { id: 'des-moines-downtown', label: 'Des Moines · Downtown', latitude: 41.5868, longitude: -93.6250, accuracy: 15, timezone: 'America/Chicago' },
  { id: 'waukee', label: 'Waukee · Downtown', latitude: 41.6110, longitude: -93.8850, accuracy: 15, timezone: 'America/Chicago' },
  { id: 'west-des-moines', label: 'West Des Moines · City Hall', latitude: 41.5772, longitude: -93.7113, accuracy: 15, timezone: 'America/Chicago' },
  { id: 'los-angeles', label: 'California · Los Angeles Downtown', latitude: 34.0522, longitude: -118.2437, accuracy: 15, timezone: 'America/Los_Angeles' },
  { id: 'new-york', label: 'New York · Midtown', latitude: 40.7549, longitude: -73.9840, accuracy: 15, timezone: 'America/New_York' }
];

export function pickLocationPreset(random: () => number = Math.random) {
  const sample = random();
  const index = Number.isFinite(sample)
    ? Math.min(LOCATION_PRESETS.length - 1, Math.max(0, Math.floor(sample * LOCATION_PRESETS.length)))
    : 0;
  return LOCATION_PRESETS[index];
}

export function installLocationPresets(onSelect: (location: SimulatedLocation | undefined) => void) {
  const locateButton = document.getElementById('locate-once');
  if (!locateButton?.parentElement) return;

  const panel = document.createElement('section');
  panel.dataset.developmentLocationPanel = 'true';
  panel.style.cssText = 'border:1px solid #4f6d56;border-radius:8px;padding:12px;margin:14px 0;background:#16231a';

  const title = document.createElement('strong');
  title.textContent = '开发测试 · 模拟定位';
  panel.append(title);

  const help = document.createElement('small');
  help.style.display = 'block';
  help.textContent = '仅影响之后的路线请求；不保存，也不会进入生产包。切换回“真实 SDK 定位”即可恢复。';
  panel.append(help);

  const select = document.createElement('select');
  select.setAttribute('aria-label', '模拟定位点');
  const real = document.createElement('option');
  real.value = '';
  real.textContent = '真实 SDK 定位';
  select.append(real);
  for (const preset of LOCATION_PRESETS) {
    const option = document.createElement('option');
    option.value = preset.id;
    option.textContent = preset.label;
    select.append(option);
  }

  const randomButton = document.createElement('button');
  randomButton.type = 'button';
  randomButton.textContent = '随机选择一个测试点';

  const status = document.createElement('small');
  status.style.display = 'block';
  status.textContent = '当前：真实 SDK 定位';

  const selectCurrent = () => {
    const selected = LOCATION_PRESETS.find(preset => preset.id === select.value);
    onSelect(selected);
    status.textContent = selected ? `当前模拟：${selected.label}` : '当前：真实 SDK 定位';
  };
  select.onchange = selectCurrent;
  randomButton.onclick = () => {
    select.value = pickLocationPreset().id;
    selectCurrent();
  };

  panel.append(select, randomButton, status);
  locateButton.parentElement.before(panel);
}
