plugins {
    id("com.android.application")
}

android {
    namespace = "app.minimaj"
    compileSdk = 34

    defaultConfig {
        applicationId = "app.minimaj"
        minSdk = 26
        targetSdk = 34
        versionCode = (project.findProperty("versionCode") as String?)?.toInt() ?: 1
        versionName = (project.findProperty("versionName") as String?) ?: "dev"
    }

    // CI signs every build with the same key so a new APK installs as an update
    // over the previous one (each runner would otherwise make a fresh debug key
    // and Android refuses the update). The key is never in the repo: CI decodes
    // the ANDROID_KEYSTORE_B64 secret to a file and passes -PminimajKeystore=<path>.
    // Without it (local builds) Gradle uses the normal per-machine debug key.
    val minimajKeystore = project.findProperty("minimajKeystore") as String?
    if (minimajKeystore != null) {
        signingConfigs {
            create("minimaj") {
                storeFile = file(minimajKeystore)
                storePassword = "android"
                keyAlias = "androiddebugkey"
                keyPassword = "android"
            }
        }
    }

    buildTypes {
        getByName("debug") {
            if (minimajKeystore != null) signingConfig = signingConfigs.getByName("minimaj")
        }
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    packaging {
        // The Go server (jniLibs/arm64-v8a/libminimaj.so) is an executable, not a
        // JNI library: it must be extracted to nativeLibraryDir so it can be run.
        jniLibs {
            useLegacyPackaging = true
        }
    }
}
