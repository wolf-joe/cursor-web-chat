import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "ltd.yooo.cursorwebchat"
    compileSdk = 36
    defaultConfig {
        applicationId = "ltd.yooo.cursorwebchat"
        minSdk = 26
        targetSdk = 36
        versionCode = 6
        versionName = "0.1.2"
    }
    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        buildConfig = true
    }
}

dependencies {
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
}

val apkDistPropsFile = rootProject.file("apk-dist.local.properties")
val apkDistProps = Properties()
if (apkDistPropsFile.exists()) {
    apkDistPropsFile.reader(Charsets.UTF_8).use { apkDistProps.load(it) }
}
val apkDistDir = apkDistProps.getProperty("apk.dist.dir")?.trim()?.trim('"')?.takeIf { it.isNotEmpty() }
val apkDistName = apkDistProps.getProperty("apk.dist.name")?.trim()?.ifEmpty { null }
    ?: "cursor-web-chat-debug.apk"

if (apkDistDir != null) {
    val destDir = file(apkDistDir)
    val copyApkToDist = tasks.register<Copy>("copyApkToDist") {
        dependsOn("assembleDebug")
        from(layout.buildDirectory.dir("outputs/apk/debug"))
        include("*.apk")
        into(destDir)
        rename { apkDistName }
        doFirst { destDir.mkdirs() }
    }
    afterEvaluate {
        tasks.named("assembleDebug").configure { finalizedBy(copyApkToDist) }
    }
}
