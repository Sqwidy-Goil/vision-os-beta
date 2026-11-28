#include <metal_stdlib>
using namespace metal;

struct WindowVertex {
    float4 position [[attribute(0)]];
    float2 uv [[attribute(1)]];
};

struct WindowUniforms {
    float4x4 viewProjection;
    float4x4 model;
    float4 tint;
    float4 params;
};

struct WindowVertexOut {
    float4 position [[position]];
    float2 uv;
    float2 local;
};

vertex WindowVertexOut window_vertex(
    uint vertexID [[vertex_id]],
    constant WindowVertex* vertices [[buffer(0)]],
    constant WindowUniforms& uniforms [[buffer(1)]]
) {
    WindowVertexOut out;
    out.position = uniforms.viewProjection * uniforms.model * vertices[vertexID].position;
    out.uv = vertices[vertexID].uv;
    out.local = vertices[vertexID].position.xy;
    return out;
}

fragment float4 window_fragment(
    WindowVertexOut in [[stage_in]],
    constant WindowUniforms& uniforms [[buffer(0)]],
    texture2d<float> content [[texture(0)]],
    sampler contentSampler [[sampler(0)]]
) {
    float2 q = abs(in.local) - float2(0.5);
    float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - 0.065;
    if (d > 0.0) discard_fragment();

    float4 texel = content.sample(contentSampler, in.uv);
    float rim = 1.0 - smoothstep(-0.035, -0.002, d);
    float sheen = smoothstep(0.2, 1.0, in.uv.y) * 0.035;
    float3 color = texel.rgb + sheen;
    color += uniforms.tint.rgb * rim * (0.18 + uniforms.params.x * 0.75);
    color += uniforms.tint.rgb * uniforms.params.y * 0.08;
    return float4(color, texel.a);
}

struct BackgroundUniforms {
    float4x4 inverseViewProjection;
    float4 cameraPosition;
    float4 topColor;
    float4 bottomColor;
    float4 params;
};

struct BackgroundVertexOut {
    float4 position [[position]];
    float2 uv;
};

vertex BackgroundVertexOut background_vertex(uint vertexID [[vertex_id]]) {
    float2 positions[3] = {
        float2(-1.0, -1.0),
        float2(3.0, -1.0),
        float2(-1.0, 3.0)
    };
    float2 p = positions[vertexID];
    BackgroundVertexOut out;
    out.position = float4(p, 0.0, 1.0);
    out.uv = p * 0.5 + 0.5;
    return out;
}

fragment float4 background_fragment(
    BackgroundVertexOut in [[stage_in]],
    constant BackgroundUniforms& uniforms [[buffer(0)]],
    texture2d<float> panorama [[texture(0)]],
    sampler panoramaSampler [[sampler(0)]]
) {
    float2 ndc = in.uv * 2.0 - 1.0;
    float4 farPoint = uniforms.inverseViewProjection * float4(ndc, 1.0, 1.0);
    float3 ray = normalize(farPoint.xyz / farPoint.w - uniforms.cameraPosition.xyz);
    float horizon = clamp(ray.y * 0.5 + 0.5, 0.0, 1.0);
    float3 color = mix(uniforms.bottomColor.rgb, uniforms.topColor.rgb, horizon);

    if (uniforms.params.x > 2.5) {
        float longitude = atan2(ray.z, ray.x) / (2.0 * 3.14159265) + 0.5;
        float latitude = asin(clamp(ray.y, -1.0, 1.0)) / 3.14159265 + 0.5;
        color = panorama.sample(panoramaSampler, float2(longitude, latitude)).rgb;
    } else {
        if (ray.y < -0.001) {
            float floorDistance = (-1.75 - uniforms.cameraPosition.y) / ray.y;
            float3 hit = uniforms.cameraPosition.xyz + ray * floorDistance;
            float2 grid = abs(fract(hit.xz * 0.5) - 0.5);
            float line = 1.0 - smoothstep(0.015, 0.045, min(grid.x, grid.y));
            float fade = exp(-max(floorDistance - 2.0, 0.0) * 0.13);
            color += mix(float3(0.12, 0.55, 0.7), float3(0.42, 0.3, 0.8), uniforms.params.x * 0.35) * line * fade * uniforms.params.y;
        }

        if (uniforms.params.x > 1.5) {
            float2 starUV = float2(atan2(ray.z, ray.x), asin(clamp(ray.y, -1.0, 1.0))) * 180.0;
            float2 cell = floor(starUV);
            float2 local = fract(starUV) - 0.5;
            float random = fract(sin(dot(cell, float2(127.1, 311.7))) * 43758.5453);
            float star = (1.0 - smoothstep(0.0, 0.08, length(local))) * step(0.965, random);
            float pulse = 0.7 + 0.3 * sin(uniforms.params.z * 1.7 + random * 20.0);
            color += star * pulse * float3(0.55, 0.85, 1.0);
            color += float3(0.02, 0.09, 0.07) * max(ray.y, 0.0) * (0.5 + 0.5 * sin(ray.x * 5.0 + uniforms.params.z * 0.15));
        }
    }

    float vignette = 1.0 - 0.16 * dot(ndc * 0.65, ndc * 0.65);
    return float4(color * vignette, 1.0);
}

struct PostUniforms {
    float4 params;
};

fragment float4 post_fragment(
    BackgroundVertexOut in [[stage_in]],
    constant PostUniforms& uniforms [[buffer(0)]],
    texture2d<float> leftEye [[texture(0)]],
    texture2d<float> rightEye [[texture(1)]],
    sampler postSampler [[sampler(0)]]
) {
    bool isLeft = in.uv.x < 0.5;
    float2 eyeUV = float2(isLeft ? in.uv.x * 2.0 : (in.uv.x - 0.5) * 2.0, in.uv.y);
    float2 centered = eyeUV * 2.0 - 1.0;
    float radiusSquared = dot(centered, centered);
    float2 corrected = centered * (1.0 + uniforms.params.x * radiusSquared) * 0.5 + 0.5;
    corrected = clamp(corrected, float2(0.001), float2(0.999));
    float3 color = leftEye.sample(postSampler, corrected).rgb;
    if (!isLeft) {
        color = rightEye.sample(postSampler, corrected).rgb;
    }

    if (uniforms.params.y > 0.5) {
        float reticleRadius = length(eyeUV - float2(0.5));
        float ring = 1.0 - smoothstep(0.0015, 0.004, abs(reticleRadius - 0.018));
        float dotShape = 1.0 - smoothstep(0.002, 0.005, reticleRadius);
        float angle = atan2(eyeUV.y - 0.5, eyeUV.x - 0.5);
        float progressArc = step(angle, uniforms.params.z * 6.2831853 - 3.14159265);
        float progressRing = ring * progressArc;
        color = mix(color, float3(0.35, 0.95, 1.0), max(ring * 0.55, dotShape));
        color = mix(color, float3(0.6, 1.0, 0.8), progressRing * 0.9);

        float2 exitUV = float2(0.93, 0.9);
        float2 p = abs(eyeUV - exitUV) - float2(0.026);
        float exitBox = length(max(p, 0.0)) + min(max(p.x, p.y), 0.0) - 0.008;
        float outline = 1.0 - smoothstep(0.0015, 0.004, abs(exitBox));
        float crossShape = (1.0 - smoothstep(0.002, 0.005, abs(eyeUV.x - exitUV.x))) * step(abs(eyeUV.y - exitUV.y), 0.009);
        crossShape += (1.0 - smoothstep(0.002, 0.005, abs(eyeUV.y - exitUV.y))) * step(abs(eyeUV.x - exitUV.x), 0.009);
        color = mix(color, float3(1.0, 0.45, 0.55), clamp(outline + crossShape, 0.0, 1.0));
    }

    if (!isLeft) {
        color *= 1.0 - 0.18 * (1.0 - smoothstep(0.0, 0.004, abs(in.uv.x - 0.5)));
    }
    return float4(color, 1.0);
}
