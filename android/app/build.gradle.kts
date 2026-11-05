plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.browserx.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.browserx.app"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0-android"
        // 门户地址：跟电脑版一样，Claude 请求走门户中转（按账号计 Tokens），App 里不放任何 Claude key
        buildConfigField("String", "PORTAL", "\"https://browserx.xingke888.com\"")
    }

    buildFeatures { buildConfig = true }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
        isCoreLibraryDesugaringEnabled = true
    }

    packaging {
        resources.excludes += setOf("META-INF/*.kotlin_module", "META-INF/versions/**", "META-INF/DEPENDENCIES", "META-INF/LICENSE*", "META-INF/NOTICE*", "META-INF/INDEX.LIST")
    }
}

kotlin { jvmToolchain(17) }

dependencies {
    implementation("com.anthropic:anthropic-java:3.5.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0") // 登录、账号接口直接用（开发包运行时也用它）
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.4")
}
