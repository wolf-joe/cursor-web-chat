package ltd.yooo.cursorwebchat

/**
 * 决策·busy-gate: 改当前 origin 只认壳 busy,不读网页 DOM。
 * 口径 = 仍有 Run watch,或 TTS 朗读会话未结束。
 */
object ShellBusy {
    @Volatile
    private var runWatchCount: Int = 0

    @Volatile
    private var ttsPlaying: Boolean = false

    fun setRunWatchCount(count: Int) {
        runWatchCount = count.coerceAtLeast(0)
    }

    fun setTtsPlaying(playing: Boolean) {
        ttsPlaying = playing
    }

    fun isBusy(): Boolean = runWatchCount > 0 || ttsPlaying
}
