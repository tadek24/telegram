import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { CallEvent, type MatrixCall, type MatrixClient } from 'matrix-js-sdk'
import { CallEventHandlerEvent } from 'matrix-js-sdk/lib/webrtc/callEventHandler'

export type CallMode = 'voice' | 'video'
export type CallPhase = 'incoming' | 'calling' | 'connecting' | 'connected' | 'ended'

export type MatrixCalls = {
  call: MatrixCall | null
  roomId: string
  mode: CallMode
  phase: CallPhase
  error: string
  muted: boolean
  videoMuted: boolean
  duration: number
  localVideoRef: RefObject<HTMLVideoElement | null>
  remoteVideoRef: RefObject<HTMLVideoElement | null>
  start: (roomId: string, mode: CallMode) => Promise<void>
  answer: () => Promise<void>
  reject: () => void
  hangup: () => void
  toggleMicrophone: () => Promise<void>
  toggleVideo: () => Promise<void>
  close: () => void
}

function callErrorMessage(error: unknown) {
  const text = `${typeof error === 'object' && error && 'code' in error ? String(error.code) : ''} ${error instanceof Error ? error.message : ''}`.toLowerCase()
  if (text.includes('no_user_media') || text.includes('notallowed') || text.includes('permission')) return 'Aplikacja nie ma dostępu do mikrofonu lub kamery. Zezwól na dostęp w ustawieniach przeglądarki.'
  if (text.includes('notfound') || text.includes('device')) return 'Nie znaleziono mikrofonu lub kamery na tym urządzeniu.'
  if (text.includes('unknown_devices')) return 'Nie można bezpiecznie rozpocząć rozmowy, ponieważ rozmówca ma niezweryfikowane urządzenie.'
  if (text.includes('ice') || text.includes('connection')) return 'Nie udało się zestawić połączenia internetowego. Spróbuj ponownie.'
  return 'Nie udało się rozpocząć rozmowy. Spróbuj ponownie.'
}

function phaseForState(state: string, current: CallPhase): CallPhase {
  if (state === 'connected') return 'connected'
  if (state === 'ended') return 'ended'
  if (state === 'ringing') return current === 'incoming' ? 'incoming' : 'calling'
  if (state === 'invite_sent') return 'calling'
  return current === 'incoming' ? 'incoming' : 'connecting'
}

function endLocalMedia(call: MatrixCall) {
  call.localUsermediaStream?.getTracks().forEach(track => track.stop())
  call.localScreensharingStream?.getTracks().forEach(track => track.stop())
}

export function useMatrixCalls(client: MatrixClient | null): MatrixCalls {
  const [call, setCall] = useState<MatrixCall | null>(null)
  const [roomId, setRoomId] = useState('')
  const [mode, setMode] = useState<CallMode>('voice')
  const [phase, setPhase] = useState<CallPhase>('ended')
  const [error, setError] = useState('')
  const [muted, setMuted] = useState(false)
  const [videoMuted, setVideoMuted] = useState(false)
  const [duration, setDuration] = useState(0)
  const [mediaRevision, setMediaRevision] = useState(0)
  const callRef = useRef<MatrixCall | null>(null)
  const phaseRef = useRef<CallPhase>('ended')
  const listenerCleanupRef = useRef<(() => void) | null>(null)
  const closeTimerRef = useRef<number | null>(null)
  const connectedAtRef = useRef(0)
  const localVideoRef = useRef<HTMLVideoElement>(null)
  const remoteVideoRef = useRef<HTMLVideoElement>(null)

  const release = useCallback((releasedCall?: MatrixCall) => {
    if (releasedCall && callRef.current !== releasedCall) return
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current)
    closeTimerRef.current = null
    listenerCleanupRef.current?.()
    listenerCleanupRef.current = null
    if (callRef.current) endLocalMedia(callRef.current)
    if (localVideoRef.current) localVideoRef.current.srcObject = null
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null
    callRef.current = null
    phaseRef.current = 'ended'
    connectedAtRef.current = 0
    setCall(null)
    setRoomId('')
    setPhase('ended')
    setError('')
    setMuted(false)
    setVideoMuted(false)
    setDuration(0)
  }, [])

  const finish = useCallback((finishedCall: MatrixCall, message = '') => {
    if (callRef.current !== finishedCall) return
    endLocalMedia(finishedCall)
    phaseRef.current = 'ended'
    setPhase('ended')
    setError(message)
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current)
    closeTimerRef.current = window.setTimeout(() => release(finishedCall), message ? 5_000 : 1_800)
  }, [release])

  const bind = useCallback((nextCall: MatrixCall, initialPhase: CallPhase, requestedMode?: CallMode) => {
    if (callRef.current && callRef.current !== nextCall) {
      try { nextCall.reject() } catch { /* the other active call stays in the foreground */ }
      return false
    }
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current)
    listenerCleanupRef.current?.()
    callRef.current = nextCall
    phaseRef.current = initialPhase
    connectedAtRef.current = 0
    setCall(nextCall)
    setRoomId(nextCall.roomId)
    setMode(requestedMode ?? (nextCall.type === 'video' ? 'video' : 'voice'))
    setPhase(initialPhase)
    setError('')
    setMuted(false)
    setVideoMuted(false)
    setDuration(0)

    const onState = (state: unknown) => {
      const nextPhase = phaseForState(String(state), phaseRef.current)
      phaseRef.current = nextPhase
      if (nextPhase === 'connected' && !connectedAtRef.current) connectedAtRef.current = Date.now()
      setPhase(nextPhase)
      setMediaRevision(value => value + 1)
      if (nextPhase === 'ended') finish(nextCall)
    }
    const onHangup = () => finish(nextCall)
    const onError = (reason: unknown) => finish(nextCall, callErrorMessage(reason))
    const onFeedsChanged = () => setMediaRevision(value => value + 1)
    nextCall.on(CallEvent.State, onState)
    nextCall.on(CallEvent.Hangup, onHangup)
    nextCall.on(CallEvent.Error, onError)
    nextCall.on(CallEvent.FeedsChanged, onFeedsChanged)
    listenerCleanupRef.current = () => {
      nextCall.off(CallEvent.State, onState)
      nextCall.off(CallEvent.Hangup, onHangup)
      nextCall.off(CallEvent.Error, onError)
      nextCall.off(CallEvent.FeedsChanged, onFeedsChanged)
    }
    return true
  }, [finish])

  useEffect(() => {
    if (!client) return
    client.setFallbackICEServerAllowed(true)
    const onIncoming = (incomingCall: MatrixCall) => {
      const room = client.getRoom(incomingCall.roomId)
      if (!room || room.getJoinedMembers().length !== 2 || callRef.current) {
        try { incomingCall.reject() } catch { /* there is no compatible call to answer */ }
        return
      }
      bind(incomingCall, 'incoming')
    }
    client.on(CallEventHandlerEvent.Incoming, onIncoming)
    return () => { client.off(CallEventHandlerEvent.Incoming, onIncoming) }
  }, [bind, client])

  useEffect(() => {
    const nextCall = callRef.current
    const attachStream = (element: HTMLVideoElement | null, stream?: MediaStream) => {
      if (!element || element.srcObject === (stream ?? null)) return
      element.srcObject = stream ?? null
      if (stream) void element.play().catch(() => undefined)
    }
    attachStream(localVideoRef.current, nextCall?.localUsermediaStream)
    attachStream(remoteVideoRef.current, nextCall?.remoteUsermediaStream)
  }, [call, mediaRevision, phase])

  useEffect(() => {
    if (phase !== 'connected') return
    const update = () => setDuration(Math.max(0, Math.floor((Date.now() - connectedAtRef.current) / 1_000)))
    update()
    const timer = window.setInterval(update, 1_000)
    return () => window.clearInterval(timer)
  }, [phase])

  useEffect(() => () => {
    const currentCall = callRef.current
    if (currentCall && phaseRef.current !== 'ended') {
      try { currentCall.hangup('user_hangup' as Parameters<MatrixCall['hangup']>[0], false) } catch { /* client is already stopping */ }
    }
    release()
  }, [client, release])

  const start = useCallback(async (targetRoomId: string, requestedMode: CallMode) => {
    if (!client || callRef.current) return
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('MEDIA_NOT_SUPPORTED')
    const room = client.getRoom(targetRoomId)
    if (!room || room.getJoinedMembers().length !== 2) throw new Error('DIRECT_CALL_REQUIRED')
    const nextCall = client.createCall(targetRoomId)
    if (!nextCall) throw new Error('CALL_NOT_SUPPORTED')
    if (!bind(nextCall, 'calling', requestedMode)) return
    try {
      if (requestedMode === 'video') await nextCall.placeVideoCall()
      else await nextCall.placeVoiceCall()
    } catch (reason) {
      finish(nextCall, callErrorMessage(reason))
    }
  }, [bind, client, finish])

  const answer = useCallback(async () => {
    const currentCall = callRef.current
    if (!currentCall || phaseRef.current !== 'incoming') return
    phaseRef.current = 'connecting'
    setPhase('connecting')
    try { await currentCall.answer(true, currentCall.type === 'video') }
    catch (reason) { finish(currentCall, callErrorMessage(reason)) }
  }, [finish])

  const reject = useCallback(() => {
    const currentCall = callRef.current
    if (!currentCall) return
    try { currentCall.reject() } finally { finish(currentCall) }
  }, [finish])

  const hangup = useCallback(() => {
    const currentCall = callRef.current
    if (!currentCall) return
    try { currentCall.hangup('user_hangup' as Parameters<MatrixCall['hangup']>[0], false) } finally { finish(currentCall) }
  }, [finish])

  const toggleMicrophone = useCallback(async () => {
    const currentCall = callRef.current
    if (!currentCall) return
    try { setMuted(await currentCall.setMicrophoneMuted(!muted)) }
    catch (reason) { setError(callErrorMessage(reason)) }
  }, [muted])

  const toggleVideo = useCallback(async () => {
    const currentCall = callRef.current
    if (!currentCall || mode !== 'video') return
    try { setVideoMuted(await currentCall.setLocalVideoMuted(!videoMuted)) }
    catch (reason) { setError(callErrorMessage(reason)) }
  }, [mode, videoMuted])

  return { call, roomId, mode, phase, error, muted, videoMuted, duration, localVideoRef, remoteVideoRef, start, answer, reject, hangup, toggleMicrophone, toggleVideo, close: release }
}

function CallGlyph({ name }: { name: 'phone' | 'video' | 'microphone' | 'microphone-off' | 'video-off' | 'close' }) {
  const paths = {
    phone: <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.4 19.4 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 2 .7 2.9a2 2 0 0 1-.5 2.1L8 10a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.5c.9.3 1.9.6 2.9.7a2 2 0 0 1 1.7 2Z"/>,
    video: <><rect x="3" y="6" width="13" height="12" rx="2"/><path d="m16 10 5-3v10l-5-3Z"/></>,
    microphone: <><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 17v5M8 22h8"/></>,
    'microphone-off': <><path d="m3 3 18 18M9 9v2a3 3 0 0 0 5.1 2.1M15 9V5a3 3 0 0 0-5.8-1M5 10a7 7 0 0 0 11 5.7M19 10a7 7 0 0 1-.7 3M12 17v5M8 22h8"/></>,
    'video-off': <><path d="m3 3 18 18M10.6 6H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h11V11.4M16 10l5-3v10l-2.1-1.3"/></>,
    close: <path d="m6 6 12 12M18 6 6 18"/>,
  }
  return <svg viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>
}

function formatDuration(seconds: number) {
  const minutes = Math.floor(seconds / 60)
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

export function CallOverlay({ calls, roomName }: { calls: MatrixCalls, roomName: string }) {
  if (!calls.call) return null
  const incoming = calls.phase === 'incoming'
  const ended = calls.phase === 'ended'
  const status = calls.error || (incoming
    ? calls.mode === 'video' ? 'Przychodząca rozmowa wideo' : 'Przychodząca rozmowa głosowa'
    : calls.phase === 'calling' ? 'Dzwonienie…'
      : calls.phase === 'connecting' ? 'Łączenie…'
        : calls.phase === 'connected' ? formatDuration(calls.duration)
          : 'Rozmowa zakończona')

  return <div className="call-layer" role="presentation">
    <section className={`call-window ${calls.mode}`} role="dialog" aria-modal="true" aria-label={`Rozmowa z ${roomName}`}>
      <div className="call-media-stage">
        <video ref={calls.remoteVideoRef} className={`call-remote-media ${calls.mode === 'voice' ? 'audio-only' : ''}`} autoPlay playsInline />
        {(calls.mode === 'voice' || !calls.call.hasRemoteUserMediaVideoTrack) && <div className="call-person"><span>{roomName.trim().charAt(0).toUpperCase() || '?'}</span><strong>{roomName}</strong><small>{status}</small></div>}
        {calls.mode === 'video' && <video ref={calls.localVideoRef} className="call-local-media" autoPlay playsInline muted />}
        {ended && <button className="call-close" type="button" onClick={calls.close} aria-label="Zamknij okno rozmowy"><CallGlyph name="close"/></button>}
      </div>
      {calls.error && <p className="call-error" role="alert">{calls.error}</p>}
      <div className="call-controls">
        {incoming ? <>
          <button className="call-control decline" type="button" onClick={calls.reject}><CallGlyph name="phone"/><span>Odrzuć</span></button>
          <button className="call-control accept" type="button" onClick={() => void calls.answer()}><CallGlyph name={calls.mode === 'video' ? 'video' : 'phone'}/><span>Odbierz</span></button>
        </> : ended ? <button className="call-finish-button" type="button" onClick={calls.close}>Zamknij</button> : <>
          <button className={`call-control ${calls.muted ? 'inactive' : ''}`} type="button" onClick={() => void calls.toggleMicrophone()}><CallGlyph name={calls.muted ? 'microphone-off' : 'microphone'}/><span>{calls.muted ? 'Włącz mikrofon' : 'Wycisz'}</span></button>
          {calls.mode === 'video' && <button className={`call-control ${calls.videoMuted ? 'inactive' : ''}`} type="button" onClick={() => void calls.toggleVideo()}><CallGlyph name={calls.videoMuted ? 'video-off' : 'video'}/><span>{calls.videoMuted ? 'Włącz kamerę' : 'Wyłącz kamerę'}</span></button>}
          <button className="call-control decline" type="button" onClick={calls.hangup}><CallGlyph name="phone"/><span>Zakończ</span></button>
        </>}
      </div>
    </section>
  </div>
}

