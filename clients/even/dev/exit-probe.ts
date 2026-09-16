// Independent diagnostic page. Not an entry point in production builds.
import { waitForEvenAppBridge, CreateStartUpPageContainer, TextContainerProperty, OsEventTypeList } from '@evenrealities/even_hub_sdk';
const log = (text: string) => { console.info(`[exit-probe] ${text}`); document.getElementById('log')!.textContent += text + '\n'; };
const bridge = await waitForEvenAppBridge();
const result = await bridge.createStartUpPageContainer(new CreateStartUpPageContainer({ containerTotalNum: 1,
  textObject: [new TextContainerProperty({ containerID: 1, containerName: 'probe', xPosition: 0, yPosition: 0,
    width: 576, height: 288, isEventCapture: 1, content: 'Exit probe\nDouble click: system confirm\nNo API. No mic. No display timer.' })] }));
log(`startup=${result}`);
let requested = false;
async function exit() {
  if (requested) return; requested = true;
  log('request exitMode=1');
  try { log(`ack=${await bridge.shutDownPageContainer(1)} (not user confirmation)`); }
  catch { log('SDK request rejected'); }
}
bridge.onEvenHubEvent(event => {
  const type = event.textEvent?.eventType ?? event.sysEvent?.eventType;
  log(`event=${type}`);
  if (type === OsEventTypeList.DOUBLE_CLICK_EVENT) void exit();
});
document.getElementById('exit')!.onclick = () => void exit();
