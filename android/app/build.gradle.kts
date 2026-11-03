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

    buildTypes {
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
