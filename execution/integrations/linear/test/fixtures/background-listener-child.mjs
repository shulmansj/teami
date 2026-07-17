import { acquireGatewayLock } from "../../src/gateway-loop.mjs";
import {
  consumeBackgroundListenerStopRequest,
  writeBackgroundListenerReady,
} from "../../src/background-listener.mjs";

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1] || null;
};
const home = process.env.TEAMI_HOME;
const lock = acquireGatewayLock({ home });
if (!lock.ok) process.exit(2);
writeBackgroundListenerReady({
  home,
  readyFile: flag("--background-ready-file"),
  nonce: flag("--background-ready-nonce"),
  controlToken: process.env.TEAMI_BACKGROUND_CONTROL_TOKEN,
});
setInterval(() => {
  if (consumeBackgroundListenerStopRequest({
    home,
    controlToken: process.env.TEAMI_BACKGROUND_CONTROL_TOKEN,
  })) {
    lock.release();
    process.exit(0);
  }
}, 100);
