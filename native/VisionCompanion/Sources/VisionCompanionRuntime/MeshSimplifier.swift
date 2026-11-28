import Foundation
import simd

struct SimplifiedMesh {
    var vertices: [SIMD3<Float>]
    var indices: [UInt32]
}

enum MeshSimplifier {
    static let maximumVertices = 4000
    static let maximumIndices = 12_000

    static func simplify(vertices: [SIMD3<Float>], indices: [UInt32]) -> SimplifiedMesh? {
        guard indices.count >= 3, indices.count % 3 == 0,
              indices.allSatisfy({ UInt($0) < vertices.count }) else { return nil }
        if vertices.count <= maximumVertices, indices.count <= maximumIndices {
            return SimplifiedMesh(vertices: vertices, indices: indices)
        }
        let cellSizes: [Float] = [0.01, 0.02, 0.04, 0.08, 0.16, 0.32]
        for cellSize in cellSizes {
            if let output = voxelSimplify(vertices: vertices, indices: indices, cellSize: cellSize) {
                return output
            }
        }
        return nil
    }

    private struct VoxelKey: Hashable {
        let x: Int64
        let y: Int64
        let z: Int64
    }

    private struct Accumulator {
        var sum = SIMD3<Float>(repeating: 0)
        var count: Int = 0
    }

    private struct TriangleKey: Hashable {
        let a: UInt32
        let b: UInt32
        let c: UInt32
    }

    private static func voxelSimplify(vertices: [SIMD3<Float>], indices: [UInt32], cellSize: Float) -> SimplifiedMesh? {
        var accumulators: [VoxelKey: Accumulator] = [:]
        var order: [VoxelKey] = []
        order.reserveCapacity(vertices.count)
        var mapping: [VoxelKey: UInt32] = [:]
        mapping.reserveCapacity(vertices.count)

        for vertex in vertices {
            guard vertex.x.isFinite, vertex.y.isFinite, vertex.z.isFinite,
                  abs(vertex.x) <= 10_000, abs(vertex.y) <= 10_000, abs(vertex.z) <= 10_000,
                  let key = voxelKey(vertex, cellSize: cellSize) else { return nil }
            if accumulators[key] == nil {
                accumulators[key] = Accumulator()
                order.append(key)
            }
            accumulators[key]!.sum += vertex
            accumulators[key]!.count += 1
            mapping[key] = UInt32(order.count - 1)
        }

        var outputVertices: [SIMD3<Float>] = []
        outputVertices.reserveCapacity(order.count)
        for key in order {
            let accumulator = accumulators[key]!
            outputVertices.append(accumulator.sum / Float(accumulator.count))
        }
        guard outputVertices.count <= maximumVertices else { return nil }

        var seen = Set<TriangleKey>()
        var outputIndices: [UInt32] = []
        outputIndices.reserveCapacity(indices.count)
        var index = 0
        while index < indices.count {
            guard let keyA = voxelKey(vertices[Int(indices[index])], cellSize: cellSize),
                  let keyB = voxelKey(vertices[Int(indices[index + 1])], cellSize: cellSize),
                  let keyC = voxelKey(vertices[Int(indices[index + 2])], cellSize: cellSize),
                  let a = mapping[keyA], let b = mapping[keyB], let c = mapping[keyC] else { return nil }
            index += 3
            guard a != b, b != c, c != a else { continue }
            let key = TriangleKey(
                a: min(a, min(b, c)),
                b: {
                    let sorted = [a, b, c].sorted()
                    return sorted[1]
                }(),
                c: max(a, max(b, c))
            )
            guard seen.insert(key).inserted else { continue }
            outputIndices.append(contentsOf: [a, b, c])
            guard outputIndices.count <= maximumIndices else { return nil }
        }
        guard outputIndices.count >= 3 else { return nil }
        return SimplifiedMesh(vertices: outputVertices, indices: outputIndices)
    }

    private static func voxelKey(_ vertex: SIMD3<Float>, cellSize: Float) -> VoxelKey? {
        guard cellSize > 0 else { return nil }
        let x = floor(vertex.x / cellSize)
        let y = floor(vertex.y / cellSize)
        let z = floor(vertex.z / cellSize)
        guard x.isFinite, y.isFinite, z.isFinite,
              let ix = Int64(exactly: x), let iy = Int64(exactly: y), let iz = Int64(exactly: z) else { return nil }
        return VoxelKey(x: ix, y: iy, z: iz)
    }
}
