package ltd.yooo.cursorwebchat.run

data class RunTerminal(val agentId: String, val status: String)

object PendingRunTerminal {
    @Volatile
    var last: RunTerminal? = null
}
