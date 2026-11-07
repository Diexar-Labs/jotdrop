package com.diexar.keepcapture

// The page data is the shape of a real TikTok video page (rehydration JSON, trimmed).
private fun videoPage(id: String = "7705168790996176142", desc: String, cover: String = "https:\\u002F\\u002Fp16.example.com\\u002Fa.image?x=1\\u0026y=2") =
    """<html><head><title>TikTok - Make Your Day</title></head><body><script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">""" +
        """{"__DEFAULT_SCOPE__":{"webapp.app-context":{"lang":"en"},"webapp.video-detail":{"itemInfo":{"itemStruct":{"id":"$id",""" +
        """"desc":"$desc","createTime":"1793999431","video":{"id":"$id","height":1280,"cover":"$cover",""" +
        """"originCover":"https:\u002F\u002Fp16.example.com\u002Fb.image","dynamicCover":""},""" +
        """"author":{"id":"6772","uniqueId":"tjrobertson52","nickname":"TJ Robertson","signature":""},"music":{"authorName":"someone else"}}},""" +
        """"statusCode":0},"webapp.a-b":{"x":1}}}"""

fun main() {
    val v = TikTokPage.parse(videoPage(desc = "Sprite sheets \\ud83d\\ude0a \\\"quoted\\\" #ClaudeAI"), "7705168790996176142")!!
    check(v.caption == "Sprite sheets \uD83D\uDE0A \"quoted\" #ClaudeAI") { v.caption.toString() }
    check(v.authorId == "tjrobertson52" && v.nickname == "TJ Robertson") { "author ${v.authorId} ${v.nickname}" }
    // \u002F and \u0026 are decoded; an empty dynamicCover is left out; the author of the sound is not the author.
    check(v.covers == listOf("https://p16.example.com/a.image?x=1&y=2", "https://p16.example.com/b.image")) { v.covers.toString() }

    // A short link has no id to compare; a different id means the page is not the video asked for.
    check(TikTokPage.parse(videoPage(desc = "x")) != null)
    check(TikTokPage.parse(videoPage(desc = "x"), "1") == null)
    check(TikTokPage.videoId("https://www.tiktok.com/@u/video/7705168790996176142?_r=1") == "7705168790996176142")
    check(TikTokPage.videoId("https://www.tiktok.com/@u/photo/123") == "123")
    check(TikTokPage.videoId("https://vm.tiktok.com/ZGdXB8vwb/") == null)

    // No caption: no caption (the title then falls back to the maker's name in OgFetcher).
    check(TikTokPage.parse(videoPage(desc = ""))!!.caption == null)
    // The page cut off after the video data (the fetch is capped) still reads.
    check(TikTokPage.parse(videoPage(desc = "cut").substringBefore("\"music\""))!!.authorId == "tjrobertson52")

    // Music page, deleted video, captcha: no video, so oEmbed takes over.
    check(TikTokPage.parse("<title>TikTok - Make Your Day</title>") == null)
    check(TikTokPage.parse("""{"webapp.app-context":{},"webapp.video-detail":{"statusCode":10204},"webapp.a-b":{"itemStruct":{"id":"1"}}}""") == null)

    // The same title on every TikTok page is not a title.
    check(TikTokPage.isGenericTitle("TikTok - Make Your Day") && TikTokPage.isGenericTitle(" tiktok - make your day "))
    check(!TikTokPage.isGenericTitle("♬ original-sound - xaeryum") && !TikTokPage.isGenericTitle(null))
    println("TikTok page checks passed")
}
