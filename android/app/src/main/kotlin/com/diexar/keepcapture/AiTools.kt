package com.diexar.keepcapture

/**
 * The tools Ask JotDrop can use, read from cloud/shared/ai/tools.json (the same list the web app uses; the build
 * copies it into the app's assets). mode: read (JotDrop answers from the notes on this device), create (a new
 * note, made at once), confirm (a change to an existing note: the user sees it first and can say no). There is no
 * tool to delete, archive, share or send.
 */
class AiTool(val name: String, val mode: String, val description: String, val inputSchema: Map<String, Any?>) {
    /** The tool as JSON for a request: name, description, input_schema. */
    fun json(): Map<String, Any?> = linkedMapOf("name" to name, "description" to description, "input_schema" to inputSchema)
}

object AiTools {
    fun load(json: String): List<AiTool> = requireNotNull(AiJson.parse(json).list()) { "tools.json must be a list" }.map { item ->
        val tool = requireNotNull(item.obj()) { "A tool must be an object" }
        AiTool(
            requireNotNull(tool.str("name")),
            requireNotNull(tool.str("mode")).also { require(it in setOf("read", "create", "confirm")) { "Unknown tool mode $it" } },
            requireNotNull(tool.str("description")),
            requireNotNull(tool.child("input_schema")),
        )
    }

    /** null when the input fits the tool's schema, otherwise what is wrong, in words the AI can act on. */
    fun validateInput(tool: AiTool, input: Any?): String? = check(tool.inputSchema, input, "input")

    private fun check(schema: Map<String, Any?>, value: Any?, path: String): String? {
        when (schema["type"]) {
            "object" -> {
                val map = value.obj() ?: return "$path must be an object"
                for (key in schema.items("required")) if (map[key as String] == null && !map.containsKey(key)) return "$path.$key is missing"
                val properties = schema.child("properties") ?: emptyMap()
                for ((key, item) in map) {
                    val property = properties.child(key) ?: return "$path.$key is not allowed"
                    check(property, item, "$path.$key")?.let { return it }
                }
                return null
            }
            "array" -> {
                val list = value.list() ?: return "$path must be a list"
                schema.num("maxItems")?.let { if (list.size > it) return "$path has more than $it items" }
                val items = schema.child("items") ?: return null
                list.forEachIndexed { index, item -> check(items, item, "$path[$index]")?.let { return it } }
                return null
            }
            "integer" -> {
                val number = value as? Number
                val whole = when (number) { is Long, is Int -> true; is Double -> number.isFinite() && number == Math.floor(number); else -> false }
                if (number == null || !whole) return "$path must be a whole number"
                val minimum = schema.num("minimum")
                val maximum = schema.num("maximum")
                val n = number.toDouble()
                if ((minimum != null && n < minimum) || (maximum != null && n > maximum)) return "$path must be from $minimum to $maximum"
                return null
            }
        }
        val text = value as? String ?: return "$path must be text"
        schema.num("maxLength")?.let { if (text.length > it) return "$path is longer than $it characters" }
        val choices = schema.items("enum")
        if (choices.isNotEmpty() && text !in choices) return "$path must be one of ${choices.joinToString(", ")}"
        schema.str("pattern")?.let { if (!Regex(it).containsMatchIn(text)) return "$path does not have the right form" }
        return null
    }
}
