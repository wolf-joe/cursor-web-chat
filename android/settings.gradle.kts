pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

plugins {
    id("com.android.application") version "8.13.0" apply false
    id("org.jetbrains.kotlin.android") version "2.0.21" apply false
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "cursor-web-chat-android"
include(":app")

val sdkDir = System.getenv("ANDROID_HOME")
    ?: System.getenv("ANDROID_SDK_ROOT")
    ?: "${System.getProperty("user.home")}/Android/Sdk"
val localProps = file("local.properties")
val escaped = sdkDir.replace("\\", "\\\\").replace(":", "\\:")
localProps.writeText("sdk.dir=$escaped\n")
