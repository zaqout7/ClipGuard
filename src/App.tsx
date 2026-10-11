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
  const [progress, setProgress] = useState<AnalysisProgress>({
    phase: 'idle',
    progressPercent: 0,
    statusText: '',
  });
  const [completedAnalysisOptions, setCompletedAnalysisOptions] = useState<AnalysisOptions | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Configuration State
  const [options, setOptions] = useState<AnalysisOptions>({
    sensitivity: 70,
    mergeToleranceSec: 2.5,
    bufferSec: 0.5,
    sampleIntervalSec: 1.5,
    categories: {
      possible_chest_exposure: true,
      possible_rear_exposure: true,
      clothing_shift_revealing: true,
      undergarment_slip: true,
      other_wardrobe_anomaly: true,
      nsfw_image_classification: true,
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
    if (currentVideo?.sourceType !== 'upload') return;
    const objectUrl = currentVideo.url;
    return () => URL.revokeObjectURL(objectUrl);
  }, [currentVideo?.id, currentVideo?.sourceType, currentVideo?.url]);

  useEffect(() => () => abortControllerRef.current?.abort(), []);

  const cancelAnalysis = () => {
    if (!abortControllerRef.current) return;
    analysisJobRef.current += 1;
    abortControllerRef.current.abort();
    abortControllerRef.current = null;
    setIsAnalyzing(false);
    setProgress({
      phase: 'cancelled',
      progressPercent: null,
      statusText: 'Analysis cancelled',
      details: 'The active browser worker was terminated. No partial results are presented.',
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
    setCurrentVideo(null);
    setDetections([]);
    setCompletedAnalysisOptions(null);
    setActiveDetection(null);
    setErrorMessage('URL analysis is unavailable. Local analysis accepts browser-selected video files only; URL metadata cannot produce valid detections.');
    setProgress({
      phase: 'error',
      progressPercent: null,
      statusText: 'Analysis unavailable',
      details: 'No video was downloaded and no remote analysis service was called.',
    });
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