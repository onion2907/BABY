#!/usr/bin/env node
// Finds a camera on the home network and works out which address it answers on.
//
//   npm run find-camera
//   npm run find-camera -- --ip 192.168.1.108
//   npm run find-camera -- --user admin --channels 1,2,3,4 --save
//
// Written to be run by someone who does not know their camera's model number.
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import * as discover from "../lib/discover.js";
import * as settings from "../lib/config.js";

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};
const has = (name) => args.includes(`--${name}`);

const say = (line = "") => console.log(line);

async function ask(question, { hidden = false } = {}) {
  const rl = readline.createInterface({ input: stdin, output: stdout, terminal: true });
  if (!hidden) {
    const answer = await rl.question(question);
    rl.close();
    return answer.trim();
  }
  // Keep the password off the screen — this gets typed in front of people.
  const promise = rl.question(question);
  const onData = () => { rl.output.write("\x1b[2K\x1b[200D" + question); };
  rl.input.on("data", onData);
  const answer = await promise;
  rl.input.off("data", onData);
  rl.close();
  say();
  return answer.trim();
}

async function main() {
  say("Looking for your camera.");
  say();

  let user = flag("user");
  let password = flag("password");
  if (user === null) user = await ask("Camera username (often 'admin'): ");
  if (password === null) password = await ask("Camera password: ", { hidden: true });

  const channels = (flag("channels", "1") ?? "1").split(",").map((c) => Number(c.trim())).filter(Boolean);

  let hosts = [];
  const givenIp = flag("ip");
  if (givenIp) {
    hosts = [givenIp];
    say(`\nChecking ${givenIp}…`);
  } else {
    const subnets = discover.localSubnets();
    if (subnets.length === 0) {
      say("\nThis computer does not seem to be on a network. Connect to your wifi and try again.");
      process.exit(1);
    }
    for (const subnet of subnets) {
      say(`\nScanning ${subnet}.1 to ${subnet}.254 for cameras — this takes about a minute.`);
      const found = await discover.scan(subnet, 554, (done, total) => {
        stdout.write(`\r  checked ${done} of ${total}…   `);
      });
      stdout.write("\r" + " ".repeat(40) + "\r");
      hosts.push(...found);
    }
    if (hosts.length === 0) {
      say("\nNo cameras answered on this network.");
      say("\nThings worth checking:");
      say("  • Is the camera switched on, and on the same wifi as this computer?");
      say("  • Many CP Plus cameras need the video stream switched on once, in their app,");
      say("    under Settings → Advanced, or by creating a separate camera user account.");
      say("  • If the camera is wired into a recorder box, find that box's address instead");
      say("    and run:  npm run find-camera -- --ip <that address> --channels 1,2,3,4");
      process.exit(1);
    }
    say(`Found ${hosts.length} device${hosts.length === 1 ? "" : "s"} that could be a camera: ${hosts.join(", ")}`);
  }

  for (const host of hosts) {
    say(`\nTrying addresses on ${host}…`);
    let attempts = 0;
    const result = await discover.probeHost(host, {
      user, password, channels,
      onTry: () => { attempts++; stdout.write(`\r  tried ${attempts} address${attempts === 1 ? "" : "es"}…   `); },
    });
    stdout.write("\r" + " ".repeat(40) + "\r");

    if (result.kind === "auth-failed") {
      say(`${host} is a camera, but it refused that username and password.`);
      say("Check them in your camera's app. Some CP Plus cameras need a separate");
      say("camera account created before anything else can connect.");
      continue;
    }

    if (result.kind === "none") {
      say(`${host} did not give a picture on any address I know.`);
      if (result.ffmpegMissing) {
        say("  (Its video stream could not be tested because ffmpeg is not installed.");
        say("   Install it with:  brew install ffmpeg   then run this again.)");
      }
      continue;
    }

    say("Found it.");
    say();
    say(`  Camera address : ${host}`);
    say(`  Type           : ${result.kind === "rtsp" ? "video stream" : "still picture"}`);
    say(`  Channel        : ${result.channel}`);
    say(`  Picture size   : ${Math.round(result.bytes / 1024)} KB`);
    say();

    const save = has("save") ||
      (await ask("Save this as the camera to watch? (y/n) ")).toLowerCase().startsWith("y");

    if (save) {
      settings.save({
        source: result.kind,
        [result.kind === "rtsp" ? "rtspUrl" : "snapshotUrl"]: result.url,
        cameraUser: user,
        cameraPassword: password,
      });
      say(`\nSaved to ${settings.CONFIG_PATH}`);
      say("\nNow run:  npm start");
      say("then open http://localhost:8080 and press Start watching.");
    } else {
      say("\nNothing saved. The address that worked was:");
      say(`\n  ${result.url}`);
    }
    return;
  }

  say("\nNone of the devices found gave a picture.");
  say("If your camera is wired into a recorder box, try that box's address with");
  say("several channels:\n\n  npm run find-camera -- --ip <box address> --channels 1,2,3,4");
  process.exit(1);
}

main().catch((err) => {
  console.error(`\nSomething went wrong: ${err.message}`);
  process.exit(1);
});
