import type {
    EmlatorFallbackSetClipboardDataCommand,
    EmulatorChunkedFileSpec,
    EmulatorClipboardData,
    EmulatorFallbackCommand,
    EmulatorFallbackEthernetReceiveCommand,
    EmulatorFallbackInputCommand,
    EmulatorFallbackUploadFileCommand,
    EmulatorFileUpload,
    EmulatorInputEvent,
    EmulatorWorkerConfig,
    EmulatorWorkerVideoBlit,
    EmulatorWorkerVideoBlitRect,
} from "./emulator-common";
import {
    isDiskImageFile,
    ethernetMacAddressFromString,
    InputBufferAddresses,
} from "./emulator-common";
import type {EmulatorWorkerAudio} from "./emulator-worker-audio";
import {
    FallbackEmulatorWorkerAudio,
    SharedMemoryEmulatorWorkerAudio,
} from "./emulator-worker-audio";
import type {EmulatorWorkerInput} from "./emulator-worker-input";
import {
    FallbackEmulatorWorkerInput,
    SharedMemoryEmulatorWorkerInput,
} from "./emulator-worker-input";
import type {EmulatorWorkerVideo} from "./emulator-worker-video";
import {
    FallbackEmulatorWorkerVideo,
    SharedMemoryEmulatorWorkerVideo,
} from "./emulator-worker-video";
import type {EmulatorWorkerFiles} from "./emulator-worker-files";
import {
    FallbackEmulatorWorkerFiles,
    SharedMemoryEmulatorWorkerFiles,
} from "./emulator-worker-files";
import {createLazyFile} from "./emulator-worker-lazy-file";
import {
    handleExtractionRequests,
    initializeExtractor,
    prepareDirectoryExtraction,
} from "./emulator-worker-extractor";
import {EmulatorWorkerChunkedDisk} from "./emulator-worker-chunked-disk";
import {restorePersistedData} from "./emulator-worker-persistence";
import type {EmulatorWorkerEthernet} from "./emulator-worker-ethernet";
import {
    FallbackEmulatorWorkerEthernet,
    SharedMemoryEmulatorWorkerEthernet,
    handlePingPacket,
    sendEthernetPacket,
} from "./emulator-worker-ethernet";
import type {EmulatorWorkerClipboard} from "./emulator-worker-clipboard";
import {
    FallbackEmulatorWorkerClipboard,
    SharedMemoryEmulatorWorkerClipboard,
} from "./emulator-worker-clipboard";
import {EmulatorWorkerDisksApi} from "./emulator-worker-disks";
import {EmulatorWorkerUploadDisk} from "./emulator-worker-upload-disk";

declare const Module: EmscriptenModule;
declare const workerCommands: EmulatorFallbackCommand[];

const PERSISTED_DIRECTORY_PATH = "/Shared/Saved";

addEventListener("message", event => {
    const {data} = event;
    const {type} = data;
    if (type === "start") {
        startEmulator(data.config);
    }
});

addEventListener("unhandledrejection", event => {
    const reasonString = event.reason.toString();
    if (reasonString.toLowerCase().includes("out of memory")) {
        postMessage({type: "emulator_did_run_out_memory"});
    } else {
        postMessage({type: "emulator_did_have_error", error: reasonString});
    }
});

class EmulatorWorkerApi {
    InputBufferAddresses = InputBufferAddresses;

    #video: EmulatorWorkerVideo;
    #input: EmulatorWorkerInput;
    #audio: EmulatorWorkerAudio;
    #files: EmulatorWorkerFiles;
    #ethernet: EmulatorWorkerEthernet;
    #clipboard: EmulatorWorkerClipboard;

    #videoOpenTime = 0;
    #lastBlitFrameId = 0;
    #nextExpectedBlitTime = 0;
    #lastIdleWaitFrameId = 0;

    #markedQuiescent = false;
    #handledStop = false;

    disks: EmulatorWorkerDisksApi;
    #delayedDiskSpecs: EmulatorChunkedFileSpec[] | undefined;
    #ethernetMacAddress?: Uint8Array;

    constructor(config: EmulatorWorkerConfig) {
        const {
            video: videoConfig,
            input: inputConfig,
            audio: audioConfig,
            files: filesConfig,
            ethernet: ethernetConfig,
            clipboard: clipboardConfig,
            disks,
            delayedDisks,
        } = config;
        const blitSender = (
            data: EmulatorWorkerVideoBlit,
            transfer: Transferable[] = []
        ) => postMessage({type: "emulator_blit", data}, transfer);
        const audioSender = (data: Uint8Array) =>
            postMessage({type: "emulator_audio", data}, [data.buffer]);

        let fallbackEndpoint: EmulatorFallbackEndpoint | undefined;
        function getFallbackEndpoint(): EmulatorFallbackEndpoint {
            if (!fallbackEndpoint) {
                fallbackEndpoint = new EmulatorFallbackEndpoint();
            }
            return fallbackEndpoint;
        }

        this.#video =
            videoConfig.type === "shared-memory"
                ? new SharedMemoryEmulatorWorkerVideo(videoConfig, blitSender)
                : new FallbackEmulatorWorkerVideo(videoConfig, blitSender);
        this.#input =
            inputConfig.type === "shared-memory"
                ? new SharedMemoryEmulatorWorkerInput(inputConfig)
                : new FallbackEmulatorWorkerInput(
                      inputConfig,
                      getFallbackEndpoint()
                  );
        this.#audio =
            audioConfig.type === "shared-memory"
                ? new SharedMemoryEmulatorWorkerAudio(audioConfig)
                : new FallbackEmulatorWorkerAudio(audioConfig, audioSender);
        this.#files =
            filesConfig.type === "shared-memory"
                ? new SharedMemoryEmulatorWorkerFiles(filesConfig)
                : new FallbackEmulatorWorkerFiles(
                      filesConfig,
                      getFallbackEndpoint()
                  );
        this.#ethernet =
            ethernetConfig.type === "shared-memory"
                ? new SharedMemoryEmulatorWorkerEthernet(ethernetConfig)
                : new FallbackEmulatorWorkerEthernet(
                      ethernetConfig,
                      getFallbackEndpoint()
                  );
        this.#clipboard =
            clipboardConfig.type === "shared-memory"
                ? new SharedMemoryEmulatorWorkerClipboard(clipboardConfig)
                : new FallbackEmulatorWorkerClipboard(
                      clipboardConfig,
                      getFallbackEndpoint()
                  );

        this.disks = new EmulatorWorkerDisksApi(
            disks.map(spec => new EmulatorWorkerChunkedDisk(spec)),
            config.useCDROM
        );
        this.#delayedDiskSpecs = delayedDisks;
    }

    didOpenVideo(width: number, height: number) {
        postMessage({type: "emulator_video_open", width, height});
        this.#videoOpenTime = performance.now();
    }

    blit(bufPtr: number, bufSize: number, rect?: EmulatorWorkerVideoBlitRect) {
        this.#lastBlitFrameId++;
        if (bufPtr) {
            const data = Module.HEAPU8.subarray(bufPtr, bufPtr + bufSize);
            this.#video.blit(data, rect);
        }
        this.#nextExpectedBlitTime = performance.now() + 16;
    }

    didOpenAudio(sampleRate: number, sampleSize: number, channels: number) {
        postMessage({
            type: "emulator_audio_open",
            sampleRate,
            sampleSize,
            channels,
        });
    }

    audioBufferSize(): number {
        return this.#audio.audioBufferSize();
    }

    enqueueAudio(bufPtr: number, nbytes: number) {
        if (
            !this.getInputValue(
                InputBufferAddresses.audioContextRunningFlagAddr
            )
        ) {
            // No point in filling up the buffer if we can't play it yet.
            return;
        }

        const newAudio = Module.HEAPU8.slice(bufPtr, bufPtr + nbytes);
        this.#audio.enqueueAudio(newAudio);
    }

    idleWait(): boolean {
        try {
            return this.#idleWait();
        } catch (err) {
            // idleWait is the main place where we invoke JS during the emulator
            // loop, make sure that we return control so that it can keep
            // running.
            console.error("Error during idlewait", err);
            return false;
        }
    }

    /**
     * Variant of idleWait that is called called more frequently (and with an
     * expected waiting time) by Mini vMac.
     */
    sleep(timeSeconds: number) {
        try {
            this.#sleep(timeSeconds);
        } catch (err) {
            console.error("Error during sleep", err);
        }
    }

    #idleWait(): boolean {
        this.#markQuiescent();

        // Don't do more than one call per frame, otherwise we end up skipping
        // frames.
        // TOOD: understand why IdleWait is called multiple times in a row
        // before VideoRefresh is called again.
        if (this.#lastIdleWaitFrameId === this.#lastBlitFrameId) {
            return false;
        }
        this.#lastIdleWaitFrameId = this.#lastBlitFrameId;

        // Time out such that we don't miss any frames (giving 2 milliseconds
        // for blit and any CPU emulation to run).
        const idleWaitTime = this.#nextExpectedBlitTime - performance.now() - 2;
        const hadInput =
            idleWaitTime > 0 ? this.#input.idleWait(idleWaitTime) : false;

        this.#periodicTasks();

        return hadInput;
    }

    #sleep(timeSeconds: number) {
        this.#input.idleWait(timeSeconds * 1000);

        if (this.#lastIdleWaitFrameId !== this.#lastBlitFrameId) {
            this.#lastIdleWaitFrameId = this.#lastBlitFrameId;
            this.#periodicTasks();

            // We don't have a more accurate way to determine when Mini vMac
            // is idle/quiscent (the Mac has finished booting), so we wait for
            // the disk writes done during boot to finish.
            if (this.disks.isDoneWithDiskWrites()) {
                this.#markQuiescent();
            }

            // System 7.0 doesn't have idlewait and doesn't do disk writes, so
            // we assume that it's done 10 seconds after video started.
            if (
                this.#videoOpenTime !== 0 &&
                performance.now() - this.#videoOpenTime > 10000
            ) {
                this.#markQuiescent();
            }
        }
    }

    #markQuiescent() {
        if (!this.#markedQuiescent) {
            this.#markedQuiescent = true;
            postMessage({type: "emulator_quiescent"});
            this.disks.validate();

            if (this.#delayedDiskSpecs) {
                for (const spec of this.#delayedDiskSpecs) {
                    console.log("Mounting delayed disk", spec.name);
                    this.disks.addDisk(new EmulatorWorkerChunkedDisk(spec));
                }
                this.#delayedDiskSpecs = undefined;
            }
        }
    }

    #periodicTasks() {
        // TODO: better place to poll for this? On the other hand, only doing it
        // when the machine is idle seems reasonable.
        this.#handleFileUploads();
        handleExtractionRequests();

        if (this.getInputValue(InputBufferAddresses.stopFlagAddr)) {
            this.#handleStop();
        }
    }

    #handleFileUploads() {
        const fileUploads = this.#files.fileUploads();
        for (const upload of fileUploads) {
            const isDiskImage = isDiskImageFile(upload.name);
            if (isDiskImage) {
                this.disks.addDisk(new EmulatorWorkerUploadDisk(upload));
                continue;
            }
            let parent = isDiskImage ? "/Disk Images/" : "/Shared/Downloads/";
            let name = upload.name;
            const pathPieces = upload.name.split("/");
            if (pathPieces.length > 1) {
                for (let i = 0; i < pathPieces.length - 1; i++) {
                    const dir = parent + pathPieces.slice(0, i + 1).join("/");
                    if (!FS.analyzePath(dir).exists) {
                        FS.mkdir(dir);
                    }
                }
                parent += pathPieces.slice(0, pathPieces.length - 1).join("/");
                name = pathPieces[pathPieces.length - 1];
            }
            createLazyFile(parent, name, upload.url, upload.size, true, true);
        }
    }

    #handleStop() {
        if (this.#handledStop) {
            return;
        }
        this.#handledStop = true;
        const [extraction, arrayBuffers] = prepareDirectoryExtraction(
            PERSISTED_DIRECTORY_PATH
        );
        postMessage({type: "emulator_stopped", extraction}, arrayBuffers);
    }

    acquireInputLock(): number {
        return this.#input.acquireInputLock();
    }

    releaseInputLock() {
        this.#input.releaseInputLock();
    }

    getInputValue(addr: number): number {
        return this.#input.getInputValue(addr);
    }

    etherSeed(): number {
        const seed = new Uint32Array(1);
        crypto.getRandomValues(seed);
        return seed[0];
    }

    etherInit(macAddress: string) {
        this.#ethernetMacAddress = ethernetMacAddressFromString(macAddress);
        postMessage({type: "emulator_ethernet_init", macAddress});
    }

    etherWrite(destination: string, packetPtr: number, packetLength: number) {
        const packet = Module.HEAPU8.slice(packetPtr, packetPtr + packetLength);
        sendEthernetPacket(destination, packet);
    }

    etherRead(packetPtr: number, packetMaxLength: number): number {
        const packet = new Uint8Array(
            Module.HEAPU8.buffer,
            Module.HEAPU8.byteOffset + packetPtr,
            packetMaxLength
        );
        const length = this.#ethernet.read(packet);
        if (
            length &&
            this.#ethernetMacAddress &&
            handlePingPacket(packet, length, this.#ethernetMacAddress)
        ) {
            return 0;
        }
        return length;
    }

    setClipboardText(text: string) {
        postMessage({type: "emulator_set_clipboard_text", text});
    }

    getClipboardText(): string | undefined {
        return this.#clipboard.clipboardText();
    }
}

export class EmulatorFallbackEndpoint {
    #commandQueue: EmulatorFallbackCommand[] = [];

    idleWait(timeout: number) {
        try {
            importScripts(
                `./worker-idlewait.js?timeout=${timeout}&t=${Date.now()}`
            );
        } catch (err) {
            console.error("Error during idlewait", err);
        }
    }

    consumeInputEvents(): EmulatorInputEvent[] {
        return this.#consumeCommands(
            (c): c is EmulatorFallbackInputCommand => c.type === "input",
            c => c.event
        );
    }

    consumeFileUploads(): EmulatorFileUpload[] {
        return this.#consumeCommands(
            (c): c is EmulatorFallbackUploadFileCommand =>
                c.type === "upload_file",
            c => c.upload
        );
    }

    consumeEthernetReceives(): Uint8Array[] {
        return this.#consumeCommands(
            (c): c is EmulatorFallbackEthernetReceiveCommand =>
                c.type === "ethernet_receive",
            c => new Uint8Array(c.packetArray)
        );
    }

    consumeSetClipboardData(): EmulatorClipboardData | undefined {
        const datas = this.#consumeCommands(
            (c): c is EmlatorFallbackSetClipboardDataCommand =>
                c.type === "set_clipboard_data",
            c => c.data
        );
        return datas[datas.length - 1];
    }

    #consumeCommands<T extends EmulatorFallbackCommand, V>(
        filter: (command: EmulatorFallbackCommand) => command is T,
        extractor: (command: T) => V
    ): V[] {
        this.#fetchCommands();
        const remainingCommands: EmulatorFallbackCommand[] = [];
        const result: V[] = [];
        for (const command of this.#commandQueue) {
            if (filter(command)) {
                result.push(extractor(command as T));
            } else {
                remainingCommands.push(command);
            }
        }
        this.#commandQueue = remainingCommands;
        return result;
    }

    #fetchCommands() {
        try {
            importScripts(`./worker-commands.js?t=${Date.now()}`);
        } catch (err) {
            console.error("Error during command fetch", err);
        }
        if (typeof workerCommands !== "undefined") {
            const commands = workerCommands;
            this.#commandQueue = this.#commandQueue.concat(commands);
        } else {
            console.warn("Could not load worker commands");
        }
    }
}

function startEmulator(config: EmulatorWorkerConfig) {
    const workerApi = new EmulatorWorkerApi(config);

    const moduleOverrides: Partial<EmscriptenModule> = {
        arguments: config.arguments,
        locateFile(path: string, scriptDirectory: string) {
            if (path.endsWith(".wasm")) {
                return config.wasmUrl;
            }
            return scriptDirectory + path;
        },

        preRun: [
            function () {
                FS.mkdir("/Shared");
                FS.mkdir("/Shared/Downloads");
                FS.mkdir("/Disk Images");
                FS.mkdir(PERSISTED_DIRECTORY_PATH);
                if (config.persistedData) {
                    restorePersistedData(
                        PERSISTED_DIRECTORY_PATH,
                        config.persistedData
                    );
                }
                initializeExtractor();

                for (const [name, buffer] of Object.entries(
                    config.autoloadFiles
                )) {
                    FS.createDataFile(
                        "/",
                        name,
                        new Uint8Array(buffer),
                        true,
                        true,
                        true
                    );
                }
            },
        ],

        onRuntimeInitialized() {
            const globalScope = globalThis as any;
            globalScope.workerApi = workerApi;
            postMessage({type: "emulator_ready"});
        },

        print(...args: any[]) {
            // Chrome's console.groupCollapsed works like a log statement,
            // so we can use it to wrap the current stack trace, which is
            // handy for debugging.
            if (
                navigator.userAgent.indexOf("Chrome") !== -1 &&
                args.length === 1 &&
                typeof args[0] === "string"
            ) {
                console.groupCollapsed(`%c${args[0]}`, "font-weight:normal");
                console.trace();
                console.groupEnd();
            } else {
                console.log(...args);
            }
        },

        printErr: console.warn.bind(console),

        quit(status: number, toThrow?: Error) {
            console.log("Emulator quit with status", status);
            if (status !== 0) {
                console.error(toThrow);
                postMessage({
                    type: "emulator_did_have_error",
                    error: toThrow
                        ? toThrow.toString()
                        : `Exit status ${status}`,
                });
            }
        },
    };
    (self as any).Module = moduleOverrides;

    importScripts(config.jsUrl);
}
