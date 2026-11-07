import { XRDevice, metaQuest3 } from 'iwer';
const d = new XRDevice(metaQuest3);
d.installRuntime({ forceInstall: true });
window.__xrdev = d;
