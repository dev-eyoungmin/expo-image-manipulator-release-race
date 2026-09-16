# expo-image-manipulator — releasing a context cancels a render that is still awaited (Android)

Minimal reproducible example for an `expo-image-manipulator` bug on **Android**: releasing an
`ImageManipulatorContext` while a `renderAsync()` promise is still pending rejects that promise with
a raw `kotlinx.coroutines.JobCancellationException`. On **iOS** the same code resolves.

It matters because the documented `useImageManipulator` hook releases the context for you when the
component unmounts — see phase C, where nothing in app code calls `release()`.

## What this app is

`npx create-expo-app@latest --template blank-typescript` (SDK 57) plus `expo-image-manipulator` and
`expo-asset`. No third-party packages. It runs three phases on mount over a bundled 4000x3000 JPEG
and renders the failure count for each. The same lines appear in `adb logcat -s ReactNativeJS`,
prefixed `REPRO`.

Every phase runs 10 rounds with the same pipeline — `resize` → `rotate` × 3 → `resize` — so a render
takes about 80 ms. The only difference between the phases is **when the context is released**.

| Phase | When `release()` happens |
| --- | --- |
| A · control | after the `renderAsync()` promise has resolved (the reference is used after the `await`) |
| B · explicit | 20 ms after the call, while the promise is still pending |
| C · `useImageManipulator` | by the hook itself, when the component unmounts mid-render |

Phase A also prints the measured render duration, so you can confirm the 20 ms release in phases B
and C lands while the render is genuinely still running.

## Steps to reproduce

1. `git clone <this repo> && cd expo-image-manipulator-release-race`
2. `npm install`
3. `npx expo run:android` (emulator or device attached)
4. Read the three cards on screen.

Then run the same commit with `npx expo run:ios` for the platform comparison.

## Result

Android: Pixel 9 Pro Fold emulator, API 36. iOS: iPhone 17 Pro simulator, iOS 26.5. Both debug
builds, Hermes, New Architecture, `expo-image-manipulator` 57.0.18.

| Phase | Android | iOS |
| --- | --- | --- |
| A | 0 / 10 failed (render ≈ 81 ms) | 0 / 10 failed (render ≈ 579 ms) |
| B | **10 / 10 failed** | 0 / 10 failed |
| C | **10 / 10 failed** | 0 / 10 failed |

Android, phases B and C:

```
Call to function 'Context.renderAsync' has been rejected.
→ Caused by: kotlinx.coroutines.JobCancellationException: DeferredCoroutine was cancelled; job=DeferredCoroutine{Cancelled}@...
```

## Why

`ImageManipulatorContext.sharedObjectDidRelease()` cancels the `Deferred` that `renderAsync()` is
awaiting:

```kotlin
// packages/expo-image-manipulator/android/src/main/java/expo/modules/imagemanipulator/ImageManipulatorContext.kt
override fun sharedObjectDidRelease() {
  task.cancel()
}
```

```kotlin
AsyncFunction("renderAsync") Coroutine { context: ImageManipulatorContext ->
  val image = context.render()   // awaits the job that release() just cancelled
  ImageRef(image, runtime)
}
```

iOS has no equivalent — `ImageManipulatorContext.swift` cancels only in `reset()`.

## Testing a fix

`expo-image-manipulator` ships a prebuilt AAR
(`node_modules/expo-image-manipulator/local-maven-repo/…/expo.modules.imagemanipulator-<version>.aar`),
so editing the Kotlin in `node_modules` has no effect on its own. This repo's `package.json` sets

```json
"expo": { "autolinking": { "buildFromSource": ["expo-image-manipulator"] } }
```

so the module is compiled from source and a local patch is picked up by `npx expo run:android`.

## Related

The same `sharedObjectDidRelease` also runs when the JS peer is **garbage collected**, which is the
harder-to-reproduce production symptom — that path is expo/expo#49799 with a fix in expo/expo#49807.
This repository reproduces what remains after that fix: an explicit `release()`, including the one
`useReleasingSharedObject` performs on unmount, cancels work a caller is still awaiting.
