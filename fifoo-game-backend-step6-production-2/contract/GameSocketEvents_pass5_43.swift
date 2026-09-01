//
//  GameSocketEvents.swift
//  fifoogame
//
//  Single source of truth for the Socket.IO event contract used by Step 2.
//

import Foundation


nonisolated enum GameSocketOutgoingEvent:
    String,
    Sendable {

    // Connection / synchronization
    case authenticate = "game:auth"
    case requestSnapshot = "game:sync:request"
    case applicationAction = "game:application:action"

    // Nodes
    case nodeAdd = "game:node:add"
    case nodeUpdate = "game:node:update"
    case nodeDelete = "game:node:delete"

    // Legacy/general activity mutations retained for compatibility.
    case activityJoin = "game:activity:join"
    case activitySkip = "game:activity:skip"
    case activityComplete = "game:activity:complete"

    // Finished ActivityTask UI — authoritative mutations.
    case activityTaskUpdate = "game:activity:task:update"
    case activityTaskReschedule = "game:activity:task:reschedule"
    case activityTaskSkip = "game:activity:task:skip"
    case activityTaskComplete = "game:activity:task:complete"

    // Finished ActivityMeal UI — the full node snapshot is the canonical
    // execution-plan mutation. Fine-grained player taps remain application
    // action telemetry and are folded into these snapshots by persistDraft().
    case activityMealUpdate = "game:activity:meal:update"
    case activityMealSkip = "game:activity:meal:skip"
    case activityMealComplete = "game:activity:meal:complete"

    // Finished ActivityWorkout stop UI. Fifoo Play session lifecycle continues
    // to use the dedicated game:play:* events below.
    case activityWorkoutUpdate = "game:activity:workout:update"
    case activityWorkoutSelect = "game:activity:workout:select"
    case activityWorkoutReschedule = "game:activity:workout:reschedule"
    case activityWorkoutCheckIn = "game:activity:workout:check-in"

    // Discovery/suggestion state that must survive another device/reconnect.
    case tileReveal = "game:tile:reveal"
    case suggestedStopDecision = "game:suggested-stop:decision"

    // Social mutations.
    case postReplyCreate = "game:post:reply:create"
    case postSave = "game:post:save"
    case hyperlinkVote = "game:hyperlink:vote"

    // Routes
    case routeSelect = "game:route:select"
    case routeBuild = "game:route:build"
    case routeAttachNode = "game:route:attach-node"
    case routeDraftUpdate = "game:route:draft:update"
    case routePreviewUpdate = "game:route:preview:update"
    case routePreviewCommit = "game:route:preview:commit"

    // Roads / map
    case roadInteraction = "game:road:interaction"

    // Search
    case searchQuery = "game:search:query"

    // Fifoo Play
    case requestPlayData = "game:play:request"
    case workoutStart = "game:play:workout:start"
    case workoutPause = "game:play:workout:pause"
    case workoutResume = "game:play:workout:resume"
    case workoutEnd = "game:play:workout:end"
    case workoutComplete = "game:play:workout:complete"
    case exerciseSelect = "game:play:exercise:select"
    case exerciseStart = "game:play:exercise:start"
    case exercisePause = "game:play:exercise:pause"
    case exerciseResume = "game:play:exercise:resume"
    case exerciseComplete = "game:play:exercise:complete"
    case exerciseSkip = "game:play:exercise:skip"
    case liveMessageSend = "game:play:message:send"
    case liveReactionSend = "game:play:reaction:send"
}


nonisolated enum GameSocketIncomingEvent:
    String,
    Sendable {

    // Synchronization
    case snapshot = "game:sync:snapshot"
    case nodeUpserted = "game:node:upserted"
    case nodeDeleted = "game:node:deleted"
    case tileRevealState = "game:tile:reveal:state"
    case routeState = "game:route:state"

    // Search
    case searchResults = "game:search:results"

    // Fifoo Play
    case workout = "game:play:workout"
    case liveMessage = "game:play:message"
    case liveMessages = "game:play:messages"
    case liveReaction = "game:play:reaction"

    // General server failure pushed outside an ack
    case serverError = "game:error"
}
