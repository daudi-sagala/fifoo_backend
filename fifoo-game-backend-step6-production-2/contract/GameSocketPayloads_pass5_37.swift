//
//  GameSocketPayloads.swift
//  fifoogame
//
//  Codable DTOs shared by the iOS client and the future Node.js server.
//

import Foundation


// =====================================================
// MARK: - Request / Ack Envelope
// =====================================================

nonisolated struct GameSocketRequestContext:
    Codable,
    Equatable,
    Sendable {

    let requestID: UUID
    let userID: String
    let deviceID: String
    let mapDate: String
    let timeZoneIdentifier: String
    let clientRevision: Int
    let sentAt: Date
}


nonisolated struct GameSocketEnvelope<Payload: Codable & Sendable>:
    Codable,
    Sendable {

    let context: GameSocketRequestContext
    let payload: Payload
}


nonisolated struct GameSocketAck:
    Codable,
    Equatable,
    Sendable {

    var success: Bool
    var requestID: UUID?
    var revision: Int?
    var message: String?
    var errorCode: String?
}


nonisolated struct GameSocketAuthenticationPayload:
    Codable,
    Equatable,
    Sendable {

    let userID: String
    let authToken: String
    let deviceID: String
}


nonisolated struct GameSocketSyncRequestPayload:
    Codable,
    Equatable,
    Sendable {

    let knownRevision: Int
    let mapDate: String
    let timeZoneIdentifier: String
}



nonisolated struct GameEmptyPayload:
    Codable,
    Equatable,
    Sendable {
}


// =====================================================
// MARK: - Generic application-action trace
// =====================================================

nonisolated struct GameApplicationActionPayload:
    Codable,
    Equatable,
    Sendable {

    let action: String
    let metadata: [String: String]
    let occurredAt: Date
}


// =====================================================
// MARK: - Nodes
// =====================================================

nonisolated struct GameNodeMutationPayload:
    Codable,
    Equatable,
    Sendable {

    let node: GameMapNode
}


nonisolated struct GameNodeDeletePayload:
    Codable,
    Equatable,
    Sendable {

    let nodeID: GameNodeID
}


nonisolated enum GameActivitySocketAction:
    String,
    Codable,
    Sendable {

    case join
    case skip
    case complete
}


nonisolated struct GameActivityMutationPayload:
    Codable,
    Equatable,
    Sendable {

    let action: GameActivitySocketAction
    let node: GameMapNode
}


nonisolated struct GameTileCellPayload:
    Codable,
    Equatable,
    Hashable,
    Sendable {

    let column: Int
    let row: Int


    init(cellID: GridCellID) {

        column = cellID.column
        row = cellID.row
    }


    var domainValue: GridCellID {

        GridCellID(
            column: column,
            row: row
        )
    }
}


nonisolated struct GameTileRevealMutationPayload:
    Codable,
    Equatable,
    Sendable {

    let cell: GameTileCellPayload
    let nodeID: GameNodeID?
    let isRevealed: Bool
}


nonisolated struct GameTileRevealServerPayload:
    Codable,
    Equatable,
    Sendable {

    let cell: GameTileCellPayload
    let isRevealed: Bool
    let revision: Int?
}


nonisolated enum GameSuggestedStopDecision:
    String,
    Codable,
    Sendable {

    case accepted
    case rejected
}


nonisolated struct GameSuggestedStopDecisionPayload:
    Codable,
    Equatable,
    Sendable {

    let cell: GameTileCellPayload
    let decision: GameSuggestedStopDecision
}


nonisolated struct GamePostReplyCreatePayload:
    Codable,
    Equatable,
    Sendable {

    let nodeID: GameNodeID
    let postID: String
    let parentReplyID: String?
    let text: String
    let createdAt: Date
}


nonisolated struct GamePostSavePayload:
    Codable,
    Equatable,
    Sendable {

    let node: GameMapNode
}


nonisolated enum GameHyperlinkVote:
    String,
    Codable,
    Sendable {

    case upvote
    case downvote
}


nonisolated struct GameHyperlinkVotePayload:
    Codable,
    Equatable,
    Sendable {

    let nodeID: GameNodeID
    let vote: GameHyperlinkVote
}


nonisolated struct GameNodeDeletedServerPayload:
    Codable,
    Equatable,
    Sendable {

    let nodeID: GameNodeID
    let revision: Int?
}


nonisolated struct GameNodeUpsertedServerPayload:
    Codable,
    Equatable,
    Sendable {

    let node: GameMapNode
    let revision: Int?
}


// =====================================================
// MARK: - Routes
// =====================================================

nonisolated struct GameCompletedRoutePayload:
    Codable,
    Equatable,
    Sendable {

    var segments: [RoadRouteSegment]
    var reachedNodeIDs: [GameNodeID]
    var throughTime: DayTime?
    var boundary: GameNodeRouteAnchor.RoadLocation?


    init(
        completedRoute: CompletedRoute
    ) {

        segments = completedRoute.segments
        reachedNodeIDs = completedRoute.reachedNodeIDs
        throughTime = completedRoute.throughTime
        boundary = completedRoute.boundary
    }


    var domainValue: CompletedRoute {

        CompletedRoute(
            segments: segments,
            reachedNodeIDs: reachedNodeIDs,
            throughTime: throughTime,
            boundary: boundary
        )
    }
}


nonisolated struct GameDayRouteStatePayload:
    Codable,
    Equatable,
    Sendable {

    var completedRoute: GameCompletedRoutePayload
    var chosenFutureRoute: GameRoute
    var alternativeRoutes: [GameRoute]
    var chosenFutureRouteActivatedAt: DayTime?


    init(
        routeState: DayRouteState
    ) {

        completedRoute =
            GameCompletedRoutePayload(
                completedRoute:
                    routeState.completedRoute
            )

        chosenFutureRoute =
            routeState.chosenFutureRoute

        alternativeRoutes =
            routeState.alternativeRoutes

        chosenFutureRouteActivatedAt =
            routeState.chosenFutureRouteActivatedAt
    }


    var domainValue: DayRouteState {

        DayRouteState(
            completedRoute:
                completedRoute.domainValue,
            chosenFutureRoute:
                chosenFutureRoute,
            alternativeRoutes:
                alternativeRoutes,
            chosenFutureRouteActivatedAt:
                chosenFutureRouteActivatedAt
        )
    }
}


nonisolated enum GameFutureRouteDraftSourcePayload:
    Codable,
    Equatable,
    Sendable {

    case newRoute
    case existingChosenRoute(RouteID)


    private enum CodingKeys:
        String,
        CodingKey {

        case type
        case routeID
    }


    private enum SourceType:
        String,
        Codable {

        case newRoute
        case existingChosenRoute
    }


    init(
        source: FutureRouteDraft.Source
    ) {

        switch source {

        case .newRoute:
            self = .newRoute

        case let .existingChosenRoute(routeID):
            self = .existingChosenRoute(routeID)
        }
    }


    init(
        from decoder: Decoder
    ) throws {

        let container =
            try decoder.container(
                keyedBy: CodingKeys.self
            )

        let type =
            try container.decode(
                SourceType.self,
                forKey: .type
            )

        switch type {

        case .newRoute:
            self = .newRoute

        case .existingChosenRoute:
            self =
                .existingChosenRoute(
                    try container.decode(
                        RouteID.self,
                        forKey: .routeID
                    )
                )
        }
    }


    func encode(
        to encoder: Encoder
    ) throws {

        var container =
            encoder.container(
                keyedBy: CodingKeys.self
            )

        switch self {

        case .newRoute:
            try container.encode(
                SourceType.newRoute,
                forKey: .type
            )

        case let .existingChosenRoute(routeID):
            try container.encode(
                SourceType.existingChosenRoute,
                forKey: .type
            )
            try container.encode(
                routeID,
                forKey: .routeID
            )
        }
    }
}


nonisolated struct GameFutureRouteDraftPayload:
    Codable,
    Equatable,
    Sendable {

    let source: GameFutureRouteDraftSourcePayload
    let stopNodeIDs: [GameNodeID]


    init(
        draft: FutureRouteDraft
    ) {

        source =
            GameFutureRouteDraftSourcePayload(
                source: draft.source
            )

        stopNodeIDs =
            draft.stopNodeIDs
    }
}


nonisolated struct GameFutureRoutePreviewPayload:
    Codable,
    Equatable,
    Sendable {

    let primaryRoute: GameRoute
    let alternativeRoutes: [GameRoute]
    let selectedRouteID: RouteID


    init(
        preview: FutureRoutePreview
    ) {

        primaryRoute = preview.primaryRoute
        alternativeRoutes = preview.alternativeRoutes
        selectedRouteID = preview.selectedRouteID
    }
}


nonisolated struct GameRouteSelectionPayload:
    Codable,
    Equatable,
    Sendable {

    let selectedRouteID: RouteID
    let routeState: GameDayRouteStatePayload
}


nonisolated struct GameRouteDraftUpdatePayload:
    Codable,
    Equatable,
    Sendable {

    let draft: GameFutureRouteDraftPayload
}


nonisolated struct GameRoutePreviewUpdatePayload:
    Codable,
    Equatable,
    Sendable {

    let preview: GameFutureRoutePreviewPayload?
}


nonisolated struct GameRouteCommitPayload:
    Codable,
    Equatable,
    Sendable {

    let routeState: GameDayRouteStatePayload
}


nonisolated struct GameRouteStateServerPayload:
    Codable,
    Equatable,
    Sendable {

    let routeState: GameDayRouteStatePayload
    let revision: Int?
}


// =====================================================
// MARK: - Roads / empty map
// =====================================================

nonisolated enum GameRoadInteractionKind:
    String,
    Codable,
    Sendable {

    case background
    case road
    case intersection
}


nonisolated struct GameRoadInteractionPayload:
    Codable,
    Equatable,
    Sendable {

    let kind: GameRoadInteractionKind
    let coordinate: MapCoordinate
    let edgeID: RoadEdgeID?
    let vertexID: RoadVertexID?
}


// =====================================================
// MARK: - Search
// =====================================================

nonisolated struct GameSearchQueryPayload:
    Codable,
    Equatable,
    Sendable {

    let query: String
    let localResultCount: Int
}


nonisolated struct GameSearchResultsPayload:
    Codable,
    Equatable,
    Sendable {

    /// Server search may return full nodes so a result not already cached on
    /// this device can be inserted before the user opens it.
    let nodes: [GameMapNode]
    let revision: Int?
}


// =====================================================
// MARK: - Fifoo Play
// =====================================================

nonisolated struct GameWorkoutMutationPayload:
    Codable,
    Equatable,
    Sendable {

    let workout: Workout
}


nonisolated struct GameWorkoutExerciseMutationPayload:
    Codable,
    Equatable,
    Sendable {

    let workoutID: UUID
    let workoutExerciseID: UUID
    let workout: Workout
}


nonisolated struct GameWorkoutLiveMessageSendPayload:
    Codable,
    Equatable,
    Sendable {

    let workoutID: UUID
    let workoutExerciseID: UUID?
    let message: String
    let createdAt: Date
}


nonisolated struct GameWorkoutLiveReactionSendPayload:
    Codable,
    Equatable,
    Sendable {

    let workoutID: UUID
    let workoutExerciseID: UUID?
    let emoji: String
    let createdAt: Date
}


nonisolated struct GameWorkoutServerPayload:
    Codable,
    Equatable,
    Sendable {

    let workout: Workout
    let revision: Int?
}


// =====================================================
// MARK: - Full day snapshot
// =====================================================

nonisolated struct GameDaySnapshotPayload:
    Codable,
    Equatable,
    Sendable {

    let revision: Int
    let nodes: [GameMapNode]
    let routeState: GameDayRouteStatePayload
    let revealedTiles: [GameTileCellPayload]?
    let workout: Workout?
    let userDailyProgress: Double?
}


nonisolated struct GameServerErrorPayload:
    Codable,
    Equatable,
    Sendable {

    let message: String
    let errorCode: String?
    let requestID: UUID?
}


// =====================================================
// MARK: - In-memory Step 2 outbox
// =====================================================

nonisolated struct GameQueuedSocketMutation:
    Identifiable,
    Equatable,
    Sendable {

    let id: UUID
    let event: String
    let requestID: UUID
    let encodedEnvelope: Data
    let queuedAt: Date
}
