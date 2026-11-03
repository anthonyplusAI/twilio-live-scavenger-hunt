import Video from 'twilio-video';

// This is the only browser module that imports the Twilio SDK. It is bundled to
// /vendor/video-client.js so the rest of the game can also run in rehearsal mode.
export async function connectPlayer({ token, roomName, stream, onDisconnected, onReconnecting, onReconnected }) {
  const source = stream?.getVideoTracks?.()[0];
  if (!source || source.readyState !== 'live') throw new Error('The camera is no longer available. Reconnect it to play.');

  const localTrack = new Video.LocalVideoTrack(source, { name: 'phone-camera' });
  let room;
  try {
    room = await Video.connect(token, {
      name: roomName,
      tracks: [localTrack],
      audio: false,
      video: false,
      dominantSpeaker: false,
      networkQuality: false,
    });
  } catch (error) {
    throw error;
  }

  room.on('disconnected', (_, error) => onDisconnected?.(error));
  room.on('reconnecting', error => onReconnecting?.(error));
  room.on('reconnected', () => onReconnected?.());
  return {
    room,
    disconnect() {
      room.disconnect();
    },
  };
}

export async function connectWall({ token, roomName, onTrack, onTrackRemoved, onDisconnected }) {
  const room = await Video.connect(token, {
    name: roomName,
    tracks: [],
    audio: false,
    video: false,
    dominantSpeaker: false,
    networkQuality: false,
  });
  const attached = new Map();

  function subscribe(track, participant) {
    if (track.kind !== 'video') return;
    const element = track.attach();
    element.autoplay = true;
    element.muted = true;
    element.playsInline = true;
    const id = `${participant.sid}:${track.sid}`;
    attached.set(id, { element, track, participant });
    onTrack?.({ identity: participant.identity, element, track });
  }
  function unsubscribe(track, participant) {
    const id = `${participant.sid}:${track.sid}`;
    const item = attached.get(id);
    if (!item) return;
    attached.delete(id);
    onTrackRemoved?.({ identity: participant.identity, element: item.element, track });
    track.detach(item.element);
    item.element.remove();
  }
  function addParticipant(participant) {
    participant.on('trackSubscribed', track => subscribe(track, participant));
    participant.on('trackUnsubscribed', track => unsubscribe(track, participant));
    for (const publication of participant.videoTracks.values()) {
      if (publication.isSubscribed && publication.track) subscribe(publication.track, participant);
    }
  }
  function removeParticipant(participant) {
    for (const item of [...attached.values()]) {
      if (item.participant === participant) unsubscribe(item.track, participant);
    }
  }

  room.on('participantConnected', addParticipant);
  room.on('participantDisconnected', removeParticipant);
  room.on('disconnected', (_, error) => onDisconnected?.(error));
  for (const participant of room.participants.values()) addParticipant(participant);

  return {
    room,
    disconnect() {
      room.disconnect();
      for (const item of [...attached.values()]) unsubscribe(item.track, item.participant);
    },
  };
}
