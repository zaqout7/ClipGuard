/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { Header } from './components/Header';
import { VideoInputBar } from './components/VideoInputBar';
import { VideoPreviewPlayer } from './components/VideoPreviewPlayer';
import { DetectionList } from './components/DetectionList';
import { AnalysisProgressBar } from './components/AnalysisProgressBar';
import { SettingsModal } from './components/SettingsModal';
import { ExportModal } from './components/ExportModal';
import { MethodologyDrawer } from './components/MethodologyDrawer';
import {
  VideoMetadata,
  DetectionEvent,
  AnalysisOptions,
  AnalysisProgress,
  SystemSpecs,
  ReviewStatus,
  AnalysisMode,
} from './types';
import { PRESET_SCENARIOS, PresetScenario } from './utils/presets';
import { formatSecondsToTimestamp } from './utils/formatters';
import { analyzeLocalVideo } from './utils/localAnalysis';
import { analyzeVideoWithGemini } from './utils/geminiAnalysis';
import { AlertCircle, Film, Sparkles, CheckCircle2 } from 'lucide-react';

export default function App() {
  // Input & Video State
  const [url, setUrl] = useState<string>('');
  const [currentVideo, setCurrentVideo] = useState<VideoMetadata | null>(null);
  const [detections, setDetections] = useState<DetectionEvent[]>([]);
  const [activeDetection, setActiveDetection] = useState<DetectionEvent | null>(null);
  const [seekTargetSeconds, setSeekTargetSeconds] = useState<number | null>(null);
  const [analysisMode, setAnalysisMode] = useState<AnalysisMode>('real_video_analysis');

  // Analysis State
  const [isAnalyzing, setIsAnalyzing] = useState<boolean>(false);
  const analysisJobRef = useRef(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  const activeSourceIdRef = useRef<string | null>(null);
  const activeYouTubeJobIdRef = useRef<string | null>(null);
  const [progress, setProgress] = useState<AnalysisProgress>({
    phase: 'idle',
    progressPercent: 0,
    statusText: '',
  });
  const [completedAnalysisOptions, setCompletedAnalysisOptions] = useState<AnalysisOptions | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Configuration State
  const [options, setOptions] = useState<AnalysisOptions>({
    sensitivity: 40,
    mergeToleranceSec: 2.5,
    bufferSec: 0.5,
    sampleIntervalSec: 1.5,
    categories: {
      possible_chest_exposure: true,    // Core explicit exposure
      possible_rear_exposure: true,     // Core explicit exposure
      nsfw_image_classification: true,  // Core explicit exposure
      clothing_shift_revealing: false,  // Optional broad review (cleavage/covered breast) — disabled by default
      undergarment_slip: false,         // Optional broad review — disabled by default
      other_wardrobe_anomaly: false,    // Optional broad review (midriff/belly) — disabled by default
      covered_buttocks_outline: false,  // Optional broad review (visible buttock outline through clothing) — disabled by default
    },
    engine: 'local_onnx',
    geminiConfig: {
      apiKey: '',
      model: 'gemini-3.8-flash',
      fps: 4,
      userConfirmedProjectBillingIntent: false,
      userConsentedVideoUpload: false,
    },
  });

  // System & Modal State
  const [systemSpecs, setSystemSpecs] = useState<SystemSpecs | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState<boolean>(false);
  const [isExportOpen, setIsExportOpen] = useState<boolean>(false);
  const [isMethodologyOpen, setIsMethodologyOpen] = useState<boolean>(false);

  // Fetch System Hardware Specs
  useEffect(() => {
    fetch('/api/system-status')
      .then((res) => res.json())
      .then((data) => {
        if (data.success) {
          setSystemSpecs(data);
        }
      })
      .catch((err) => {
        console.warn('System status check skipped:', err);
      });
  }, []);

  useEffect(() => {
    if (currentVideo?.sourceType !== 'upload' && currentVideo?.sourceType !== 'youtube') return;
    const objectUrl = currentVideo.url;
    const videoId = currentVideo.id;
    return () => {
      URL.revokeObjectURL(objectUrl);
      if (videoId.startsWith('yt-')) {
        const jobId = videoId.slice(3);
        fetch(`/api/youtube/cleanup/${jobId}`, { method: 'POST' }).catch(() => {});
      }
    };
  }, [currentVideo?.id, currentVideo?.sourceType, currentVideo?.url]);

  useEffect(() => () => abortControllerRef.current?.abort(), []);

  const cancelAnalysis = () => {
    if (activeYouTubeJobIdRef.current) {
      const ytId = activeYouTubeJobIdRef.current;
      activeYouTubeJobIdRef.current = null;
      fetch(`/api/youtube/cancel/${ytId}`, { method: 'POST' }).catch(() => {});
    }
    if (!abortControllerRef.current && !isAnalyzing) return;
    analysisJobRef.current += 1;
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setIsAnalyzing(false);
    setProgress({
      phase: 'cancelled',
      progressPercent: null,
      statusText: 'Analysis cancelled',
      details: 'The active operation was cancelled. No partial results are presented.',
      incomplete: true,
    });
  };

  const startLocalAnalysis = async (file: File, sourceId: string) => {
    abortControllerRef.current?.abort();
    const jobId = ++analysisJobRef.current;
    activeSourceIdRef.current = sourceId;
    const controller = new AbortController();
    const runOptions = { ...options, categories: { ...options.categories } };
    abortControllerRef.current = controller;
    setIsAnalyzing(true);
    setErrorMessage(null);
    setDetections([]);
    setCompletedAnalysisOptions(null);
    setActiveDetection(null);
    setProgress({
      phase: 'preparing_video',
      progressPercent: null,
      statusText: 'Preparing local analysis',
      details: `Job ${jobId} is bound to the selected file "${file.name}".`,
    });

    try {
      if (runOptions.engine === 'gemini_video') {
        const geminiRes = await analyzeVideoWithGemini({
          file,
          sourceId,
          options: runOptions,
          signal: controller.signal,
          onProgress: (nextProgress) => {
            if (jobId === analysisJobRef.current && sourceId === activeSourceIdRef.current) {
              setProgress(nextProgress);
            }
          },
        });
        if (jobId !== analysisJobRef.current || sourceId !== activeSourceIdRef.current) return;
        setDetections(geminiRes.detections);
        setCompletedAnalysisOptions(runOptions);
        setActiveDetection(geminiRes.detections[0] ?? null);
        setProgress({
          phase: 'complete',
          progressPercent: 100,
          statusText: 'Gemini 4 FPS analysis complete — review potential matches',
          details: `Analyzed via Google Gemini API at exactly 4 FPS (${geminiRes.report.samplingRateDescription}, videoMetadata.fps: 4). ${geminiRes.report.frameCoverageNotice} ${geminiRes.report.interFrameWarning} ${
            geminiRes.detections.length === 0 ? 'No sampled frames exceeded the threshold; this is not evidence that the video is safe.' : ''
          }`,
          currentCandidateCount: geminiRes.detections.length,
          incomplete: false,
        });
        return;
      }

      const result = await analyzeLocalVideo({
        file,
        sourceId,
        options: runOptions,
        signal: controller.signal,
        onProgress: (nextProgress) => {
          if (jobId === analysisJobRef.current && sourceId === activeSourceIdRef.current) {
            setProgress(nextProgress);
          }
        },
      });
      if (jobId !== analysisJobRef.current || sourceId !== activeSourceIdRef.current) return;
      setDetections(result.detections);
      setCompletedAnalysisOptions(runOptions);
      setActiveDetection(result.detections[0] ?? null);
      setCurrentVideo((video) =>
        video?.id === sourceId
          ? {
              ...video,
              durationSeconds: result.durationSeconds,
              durationFormatted: formatSecondsToTimestamp(result.durationSeconds),
            }
          : video
      );
      setProgress({
        phase: 'complete',
        progressPercent: 100,
        statusText: result.detectorBackend === 'vit'
          ? 'Analysis complete (ViT Fallback) — review potential matches'
          : 'Analysis complete — review potential matches',
        details: result.fallbackWarning
          ? `[FALLBACK MODE: ${result.fallbackWarning}] ${result.sampledFrames} sampled frames analyzed locally using ${result.provider}.`
          : result.detections.length
          ? `${result.sampledFrames} sampled frames analyzed locally using ${result.provider} (${result.detectorBackend === 'nudenet' ? 'NudeNet detector' : 'ViT fallback'}). Matches require human review; sparse sampling may miss brief content. ${result.usedSeekTimeFallback ? 'Some timestamps use seek-time fallback rather than decoded-frame mediaTime.' : 'Timestamps use decoded-frame mediaTime.'}`
          : `${result.sampledFrames} sampled frames analyzed locally using ${result.provider} (${result.detectorBackend === 'nudenet' ? 'NudeNet detector' : 'ViT fallback'}). No sampled frame exceeded the selected threshold; this is not evidence that the video is safe. ${result.usedSeekTimeFallback ? 'Some timestamps used seek-time fallback.' : 'Timestamps use decoded-frame mediaTime.'}`,
        currentCandidateCount: result.detections.length,
        processedFrames: result.sampledFrames,
        totalFrames: result.sampledFrames,
        incomplete: false,
      });
    } catch (error) {
      if (jobId !== analysisJobRef.current || sourceId !== activeSourceIdRef.current) return;
      if (error instanceof DOMException && error.name === 'AbortError') {
        setProgress({
          phase: 'cancelled',
          progressPercent: null,
          statusText: 'Analysis cancelled',
          details: 'The active browser worker was terminated. No partial results are presented.',
          incomplete: true,
        });
      } else {
        const message = error instanceof Error ? error.message : 'Unknown local analysis error.';
        setErrorMessage(`Local analysis failed: ${message}`);
        setProgress({
          phase: 'error',
          progressPercent: null,
          statusText: 'Analysis failed',
          details: 'No completed result is available. The local worker has been stopped and can be restarted.',
          incomplete: true,
        });
      }
    } finally {
      if (jobId === analysisJobRef.current) {
        abortControllerRef.current = null;
        setIsAnalyzing(false);
      }
    }
  };

  // YouTube Acquisition + On-Device Local Analysis Pipeline
  const handleYouTubeAnalysis = async (rawUrl: string) => {
    cancelAnalysis();
    const jobId = ++analysisJobRef.current;
    const controller = new AbortController();
    abortControllerRef.current = controller;
    setIsAnalyzing(true);
    setErrorMessage(null);
    setDetections([]);
    setCompletedAnalysisOptions(null);
    setActiveDetection(null);

    const ytJobId = crypto.randomUUID();
    activeYouTubeJobIdRef.current = ytJobId;

    setProgress({
      phase: 'preparing_video',
      progressPercent: null,
      statusText: 'Contacting YouTube via local service…',
      details: 'Retrieving video stream details for local on-device analysis.',
    });

    try {
      // 1. Fetch metadata using local yt-dlp service
      const infoRes = await fetch('/api/youtube/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: rawUrl }),
        signal: controller.signal,
      });

      const infoData = await infoRes.json();
      if (!infoRes.ok || !infoData.success) {
        throw new Error(infoData.error || 'Failed to query YouTube video.');
      }

      const metadata: VideoMetadata = infoData.metadata;
      if (jobId !== analysisJobRef.current) return;

      // 2. Start background download via yt-dlp
      const prepRes = await fetch('/api/youtube/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: rawUrl, jobId: ytJobId, metadata }),
        signal: controller.signal,
      });

      const prepData = await prepRes.json();
      if (!prepRes.ok || !prepData.success) {
        throw new Error(prepData.error || 'Failed to initialize YouTube video download.');
      }

      // 3. Poll download progress
      let downloadComplete = false;
      while (!downloadComplete) {
        if (controller.signal.aborted || jobId !== analysisJobRef.current) {
          return;
        }

        await new Promise((r) => setTimeout(r, 600));
        if (controller.signal.aborted || jobId !== analysisJobRef.current) {
          return;
        }

        const pollRes = await fetch(`/api/youtube/progress/${ytJobId}`, {
          signal: controller.signal,
        });
        if (!pollRes.ok) throw new Error('Failed to track video download progress.');
        const pollData = await pollRes.json();

        if (pollData.status === 'error') {
          throw new Error(pollData.error || 'YouTube download failed.');
        } else if (pollData.status === 'cancelled') {
          return;
        } else if (pollData.status === 'ready') {
          downloadComplete = true;
          break;
        } else {
          setProgress({
            phase: 'preparing_video',
            progressPercent: pollData.progressPercent ?? null,
            statusText: `Downloading YouTube video locally (${pollData.progressPercent ?? 0}%)`,
            details: `Fetching "${metadata.title}" via local yt-dlp for on-device CPU analysis.`,
          });
        }
      }

      if (jobId !== analysisJobRef.current) return;

      // 4. Retrieve downloaded video file blob
      setProgress({
        phase: 'preparing_video',
        progressPercent: 100,
        statusText: 'Preparing video for local decoding…',
        details: 'Loading downloaded video into local analysis pipeline.',
      });

      const fileRes = await fetch(`/api/youtube/file/${ytJobId}`, {
        signal: controller.signal,
      });
      if (!fileRes.ok) throw new Error('Failed to load downloaded video file.');
      const blob = await fileRes.blob();

      if (jobId !== analysisJobRef.current) return;

      const safeTitle = (metadata.title || 'youtube_video').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 50);
      const videoFile = new File([blob], `${safeTitle}.mp4`, { type: 'video/mp4' });
      const localUrl = URL.createObjectURL(videoFile);

      const resolvedVideoMeta: VideoMetadata = {
        ...metadata,
        id: `yt-${ytJobId}`,
        url: localUrl,
      };

      setCurrentVideo(resolvedVideoMeta);
      activeSourceIdRef.current = resolvedVideoMeta.id;
      activeYouTubeJobIdRef.current = null;

      // 5. Feed into selected analysis pipeline (Local ONNX or Gemini Video 4 FPS)
      const runOptions = { ...options, categories: { ...options.categories } };

      if (runOptions.engine === 'gemini_video') {
        const geminiRes = await analyzeVideoWithGemini({
          youtubeJobId: ytJobId,
          sourceId: resolvedVideoMeta.id,
          options: runOptions,
          signal: controller.signal,
          onProgress: (nextProgress) => {
            if (jobId === analysisJobRef.current && resolvedVideoMeta.id === activeSourceIdRef.current) {
              setProgress(nextProgress);
            }
          },
          videoDurationSeconds: metadata.durationSeconds,
        });

        if (jobId !== analysisJobRef.current || resolvedVideoMeta.id !== activeSourceIdRef.current) return;

        setDetections(geminiRes.detections);
        setCompletedAnalysisOptions(runOptions);
        setActiveDetection(geminiRes.detections[0] ?? null);
        setProgress({
          phase: 'complete',
          progressPercent: 100,
          statusText: 'Gemini 4 FPS analysis complete — review potential matches',
          details: `Analyzed via Google Gemini API at exactly 4 FPS (${geminiRes.report.samplingRateDescription}, videoMetadata.fps: 4). ${geminiRes.report.frameCoverageNotice} ${geminiRes.report.interFrameWarning} ${
            geminiRes.detections.length === 0 ? 'No sampled frames exceeded the threshold; this is not evidence that the video is safe.' : ''
          }`,
          currentCandidateCount: geminiRes.detections.length,
          incomplete: false,
        });
        return;
      }

      const result = await analyzeLocalVideo({
        file: videoFile,
        sourceId: resolvedVideoMeta.id,
        options: runOptions,
        signal: controller.signal,
        onProgress: (nextProgress) => {
          if (jobId === analysisJobRef.current && resolvedVideoMeta.id === activeSourceIdRef.current) {
            setProgress(nextProgress);
          }
        },
      });

      if (jobId !== analysisJobRef.current || resolvedVideoMeta.id !== activeSourceIdRef.current) return;

      setDetections(result.detections);
      setCompletedAnalysisOptions(runOptions);
      setActiveDetection(result.detections[0] ?? null);
      setCurrentVideo((video) =>
        video?.id === resolvedVideoMeta.id
          ? {
              ...video,
              durationSeconds: result.durationSeconds || video.durationSeconds,
              durationFormatted: formatSecondsToTimestamp(result.durationSeconds || video.durationSeconds),
            }
          : video
      );

      setProgress({
        phase: 'complete',
        progressPercent: 100,
        statusText: 'Analysis complete — review potential matches',
        details: result.detections.length
          ? `${result.sampledFrames} sampled frames analyzed locally using ${result.provider}. Matches require human review; sparse sampling may miss brief content. ${result.usedSeekTimeFallback ? 'Some timestamps use seek-time fallback rather than decoded-frame mediaTime.' : 'Timestamps use decoded-frame mediaTime.'}`
          : `${result.sampledFrames} sampled frames analyzed locally using ${result.provider}. No sampled frame exceeded the selected threshold; this is not evidence that the video is safe. ${result.usedSeekTimeFallback ? 'Some timestamps used seek-time fallback.' : 'Timestamps use decoded-frame mediaTime.'}`,
        currentCandidateCount: result.detections.length,
        processedFrames: result.sampledFrames,
        totalFrames: result.sampledFrames,
        incomplete: false,
      });
    } catch (error) {
      if (jobId !== analysisJobRef.current) return;
      if (error instanceof DOMException && error.name === 'AbortError') {
        setProgress({
          phase: 'cancelled',
          progressPercent: null,
          statusText: 'Analysis cancelled',
          details: 'The active operation was cancelled. No partial results are presented.',
          incomplete: true,
        });
      } else {
        const message = error instanceof Error ? error.message : 'Unknown YouTube analysis error.';
        setErrorMessage(`YouTube analysis failed: ${message}`);
        setProgress({
          phase: 'error',
          progressPercent: null,
          statusText: 'Analysis failed',
          details: 'No completed result is available. The downloaded file or process was stopped and can be restarted.',
          incomplete: true,
        });
      }
    } finally {
      if (jobId === analysisJobRef.current) {
        abortControllerRef.current = null;
        activeYouTubeJobIdRef.current = null;
        setIsAnalyzing(false);
      }
    }
  };

  // Main YouTube / Preset Analysis Handler
  const handleAnalyze = (customUrl?: string, preset?: PresetScenario) => {
    setErrorMessage(null);
    cancelAnalysis();

    // Demo data is illustrative only and does not represent analyzed video.
    if (preset) {
      setAnalysisMode('preset_demo');
      setUrl(preset.metadata.url);
      setCurrentVideo(preset.metadata);

      const filteredPreset = preset.detections.filter(
        (d) => (d.confidence ?? 0) >= options.sensitivity && options.categories[d.category] !== false
      );

      setDetections(filteredPreset);
      setActiveDetection(filteredPreset[0] || null);
      setIsAnalyzing(false);
      setProgress({
        phase: 'idle',
        progressPercent: 0,
        statusText: 'Demo data loaded — not analyzed',
        details: 'Illustrative timestamps and scores only; no video was processed.',
        currentCandidateCount: filteredPreset.length,
      });
      return;
    }

    const targetUrl = customUrl || url;
    if (!targetUrl.trim()) {
      setErrorMessage('Select a local video or enter a supported YouTube URL.');
      return;
    }

    setAnalysisMode('real_video_analysis');
    void handleYouTubeAnalysis(targetUrl.trim());
  };

  // The selected file is decoded and analyzed locally in the browser worker.
  const handleFileUpload = (file: File) => {
    if (!file.type.startsWith('video/') && !/\.(mp4|webm|mov|m4v|avi|mkv)$/i.test(file.name)) {
      setErrorMessage('Choose a supported video file (MP4, WebM, MOV, M4V, AVI, or MKV).');
      return;
    }

    setErrorMessage(null);
    setAnalysisMode('real_video_analysis');

    abortControllerRef.current?.abort();
    const localUrl = URL.createObjectURL(file);
    const videoMeta: VideoMetadata = {
      id: `local-${crypto.randomUUID()}`,
      url: localUrl,
      title: file.name,
      author: 'Local file',
      durationSeconds: 0,
      durationFormatted: 'Unknown until preview metadata loads',
      thumbnailUrl: '',
      sourceType: 'upload',
    };

    setCurrentVideo(videoMeta);
    setUrl('');
    setDetections([]);
    setActiveDetection(null);
    setProgress({ phase: 'preparing_video', progressPercent: null, statusText: 'Starting local analysis', details: 'The video remains in this browser.' });
    void startLocalAnalysis(file, videoMeta.id);
  };

  const handleLoadDemo = () => {
    handleAnalyze(undefined, PRESET_SCENARIOS[0]);
  };

  // Review Status Updates
  const handleUpdateStatus = (id: string, newStatus: ReviewStatus) => {
    setDetections((prev) =>
      prev.map((d) => (d.id === id ? { ...d, reviewStatus: newStatus } : d))
    );
    if (activeDetection?.id === id) {
      setActiveDetection((prev) =>
        newStatus === 'dismissed' ? null : prev ? { ...prev, reviewStatus: newStatus } : null
      );
    }
  };

  // Review Notes Updates
  const handleUpdateNotes = (id: string, notes: string) => {
    setDetections((prev) =>
      prev.map((d) => (d.id === id ? { ...d, editorNotes: notes } : d))
    );
    if (activeDetection?.id === id) {
      setActiveDetection((prev) => (prev ? { ...prev, editorNotes: notes } : null));
    }
  };

  // Jump Seek Trigger
  const handleJumpToTimestamp = (seconds: number) => {
    setSeekTargetSeconds(seconds);
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-rose-500 selection:text-white">
      {/* Top Navigation */}
      <Header
        systemSpecs={systemSpecs}
        onOpenSettings={() => setIsSettingsOpen(true)}
        onOpenMethodology={() => setIsMethodologyOpen(true)}
      />

      {/* Main App Container */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-4 sm:p-6 flex flex-col gap-5">
        {/* Video Input & Presets Bar */}
        <VideoInputBar
          url={url}
          setUrl={setUrl}
          isAnalyzing={isAnalyzing}
          onAnalyze={handleAnalyze}
          onLoadDemo={handleLoadDemo}
          onFileUpload={handleFileUpload}
          currentVideo={currentVideo}
        />

        {/* Error Alert Display */}
        {errorMessage && (
          <div className="p-4 rounded-xl bg-rose-950/60 border border-rose-800 text-rose-200 text-xs flex items-center justify-between gap-3 shadow-lg">
            <div className="flex items-center gap-2">
              <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
              <span>{errorMessage}</span>
            </div>
            <button
              onClick={() => setErrorMessage(null)}
              className="px-2 py-1 rounded bg-rose-900/60 hover:bg-rose-800 text-white font-mono text-[11px]"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Dynamic Progress Indicator */}
        <AnalysisProgressBar progress={progress} onCancel={cancelAnalysis} isAnalyzing={isAnalyzing} />

        {/* Two-Column Editor Workspace */}
        {currentVideo ? (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
            {/* Left Column: Video Preview & Interactive Scrub Timeline */}
            <div className="lg:col-span-7 flex flex-col gap-3">
              <VideoPreviewPlayer
                video={currentVideo}
                detections={detections}
                activeDetection={activeDetection}
                onSelectDetection={(det) => setActiveDetection(det)}
                onVideoMetadata={(durationSeconds) =>
                  setCurrentVideo((video) =>
                    video?.id === currentVideo.id
                      ? {
                          ...video,
                          durationSeconds,
                          durationFormatted: formatSecondsToTimestamp(durationSeconds),
                        }
                      : video
                  )
                }
                seekTargetSeconds={seekTargetSeconds}
                onSeekComplete={() => setSeekTargetSeconds(null)}
              />

              {/* Video Metadata Box with Mode Transparency Badge */}
              <div className="p-3.5 rounded-xl bg-slate-900/80 border border-slate-800 flex items-center justify-between gap-3">
                <div className="overflow-hidden">
                  <div className="flex items-center gap-2">
                    <h3 className="text-xs font-bold text-white truncate">
                      {currentVideo.title}
                    </h3>
                    {analysisMode === 'preset_demo' ? (
                      <span className="shrink-0 px-2 py-0.5 rounded text-[10px] font-bold bg-amber-950/80 text-amber-400 border border-amber-800/60 flex items-center gap-1">
                        <Sparkles className="w-3 h-3" />
                        Demo data only — not analyzed
                      </span>
                    ) : (
                      <span className="shrink-0 px-2 py-0.5 rounded text-[10px] font-bold bg-rose-950/80 text-rose-300 border border-rose-800/60">
                        {progress.phase === 'complete' ? 'Analyzed locally — review required' : 'Local analysis status'}
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] text-slate-400 truncate mt-0.5">
                    {currentVideo.author} • Duration: {currentVideo.durationFormatted}
                  </p>
                </div>
                <span className="shrink-0 text-[10px] font-mono px-2 py-0.5 rounded bg-slate-800 text-slate-400 border border-slate-700">
                  {currentVideo.sourceType.toUpperCase()}
                </span>
              </div>
            </div>

            {/* Right Column: Candidate Detections List & Human Review Tools */}
            <div className="lg:col-span-5">
              <DetectionList
                detections={detections}
                progress={progress}
                demoOnly={analysisMode === 'preset_demo'}
                activeDetection={activeDetection}
                onSelectDetection={(det) => setActiveDetection(det)}
                onUpdateStatus={handleUpdateStatus}
                onUpdateNotes={handleUpdateNotes}
                onJumpToTimestamp={handleJumpToTimestamp}
                onOpenExport={() => setIsExportOpen(true)}
                videoTitle={currentVideo.title}
              />
            </div>
          </div>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center p-12 border-2 border-dashed border-slate-800 rounded-3xl text-center">
            <Film className="w-12 h-12 text-slate-600 mb-3" />
            <h3 className="text-base font-bold text-slate-300">No Video Loaded</h3>
            <p className="text-xs text-slate-500 max-w-md mt-1">
              Upload a local video file for on-device frame sampling and NSFW image classification, or select an editor test preset.
            </p>
          </div>
        )}
      </main>

      {/* Settings Modal */}
      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        options={options}
        onOptionsChange={setOptions}
      />

      {/* Export Modal */}
      {currentVideo && (
        <ExportModal
          isOpen={isExportOpen}
          onClose={() => setIsExportOpen(false)}
          video={currentVideo}
          detections={detections}
          progress={progress}
          options={completedAnalysisOptions ?? options}
        />
      )}

      {/* Methodology & Architecture Drawer */}
      <MethodologyDrawer
        isOpen={isMethodologyOpen}
        onClose={() => setIsMethodologyOpen(false)}
      />
    </div>
  );
}