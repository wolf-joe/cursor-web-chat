// 决策·done-chime: run 结束时用 Web Audio 合成一声短 chime,不引入音频文件。
// AudioContext 受浏览器 autoplay 策略约束,须在用户手势里 unlock(见 composer 发送时)。

let ctx = null;

function getCtx() {
  if (!ctx) ctx = new AudioContext();
  return ctx;
}

/** 在发送消息等用户手势里调用,解锁 AudioContext,否则后台 tab 等回复结束时可能静音。 */
export function unlockAudio() {
  const c = getCtx();
  if (c.state === "suspended") void c.resume();
}

/** 柔和双音上行叮咚——对话正常结束的提示音。 */
export function playDoneChime() {
  try {
    const c = getCtx();
    if (c.state === "suspended") void c.resume();
    const now = c.currentTime;
    const master = c.createGain();
    // 总音量 0~1;0.12 偏安静,0.35 正常可闻,再高容易刺耳。
    master.gain.setValueAtTime(0.35, now);
    master.connect(c.destination);

    // C5 → E5,约 280ms,正弦波衰减
    for (const [freq, start] of [
      [523.25, 0],
      [659.25, 0.12],
    ]) {
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, now + start);
      gain.gain.linearRampToValueAtTime(1, now + start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, now + start + 0.22);
      osc.connect(gain);
      gain.connect(master);
      osc.start(now + start);
      osc.stop(now + start + 0.25);
    }
  } catch {
    // 无 AudioContext / 策略拦截——静默失败,不影响对话
  }
}
