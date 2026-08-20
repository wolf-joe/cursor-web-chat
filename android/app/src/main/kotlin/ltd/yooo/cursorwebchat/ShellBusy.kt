package ltd.yooo.cursorwebchat

/**
 * 决策·busy-gate: 改当前 origin 只认壳 busy,不读网页 DOM。
 * 现口径 = 仍有 Run watch;TTS 落地后在此并入。
 */
object ShellBusy {
    @Volatile
    private var runWatchCount: Int = 0

    fun setRunWatchCount(count: Int) {
        runWatchCount = count.coerceAtLeast(0)
    }

    fun isBusy(): Boolean = runWatchCount > 0
}
