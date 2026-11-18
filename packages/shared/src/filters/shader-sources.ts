/**
 * WebGL2 Custom Shaders for AtelierSync GPU Filter Pipeline
 *
 * All fragment shaders are written in standard GLSL ES 3.00 (WebGL2 compatible)
 * with support for FBO Ping-Pong rendering.
 */

/**
 * Standard Vertex Shader for 2D Screen Quad
 */
export const SCREEN_QUAD_VERTEX_SHADER = /* glsl */ `#version 300 es
layout(location = 0) in vec2 a_position;
layout(location = 1) in vec2 a_texCoord;

out vec2 v_texCoord;

void main() {
    v_texCoord = a_texCoord;
    gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

/**
 * 1. Dual-Pass Gaussian Blur Fragment Shader (Separable 1D Kernel)
 * Runs horizontal pass (u_direction = [1, 0]) then vertical pass (u_direction = [0, 1])
 */
export const GAUSSIAN_BLUR_FRAGMENT_SHADER = /* glsl */ `#version 300 es
precision highp float;

in vec2 v_texCoord;
out vec4 fragColor;

uniform sampler2D u_texture;
uniform vec2 u_direction;     // vec2(1.0 / width, 0.0) or vec2(0.0, 1.0 / height)
uniform float u_radius;       // Blur radius (1.0 to 32.0)

void main() {
    vec4 color = vec4(0.0);
    float totalWeight = 0.0;
    float r = max(1.0, u_radius);
    float sigma = max(0.5, r / 2.5);
    float twoSigmaSq = 2.0 * sigma * sigma;

    int steps = int(clamp(ceil(r), 1.0, 24.0));

    for (int i = -steps; i <= steps; i++) {
        float fi = float(i);
        float weight = exp(-(fi * fi) / twoSigmaSq);
        vec2 offset = float(i) * u_direction;
        color += texture(u_texture, v_texCoord + offset) * weight;
        totalWeight += weight;
    }

    fragColor = color / max(totalWeight, 0.0001);
}
`;

/**
 * 2. Twirl / Vortex Distortion Fragment Shader
 */
export const TWIRL_DISTORTION_FRAGMENT_SHADER = /* glsl */ `#version 300 es
precision highp float;

in vec2 v_texCoord;
out vec4 fragColor;

uniform sampler2D u_texture;
uniform vec2 u_center;       // Normalized [0..1]
uniform float u_radius;      // Normalized radius [0..1]
uniform float u_angle;       // Rotation angle in radians
uniform vec2 u_aspectRatio;  // vec2(aspect, 1.0) to prevent elliptical warping

void main() {
    vec2 coord = (v_texCoord - u_center) * u_aspectRatio;
    float dist = length(coord);

    if (dist < u_radius && dist > 0.0001) {
        float percent = (u_radius - dist) / u_radius;
        float theta = percent * percent * u_angle;
        float s = sin(theta);
        float c = cos(theta);
        coord = vec2(coord.x * c - coord.y * s, coord.x * s + coord.y * c);
    }

    vec2 sampleCoord = (coord / u_aspectRatio) + u_center;
    fragColor = texture(u_texture, sampleCoord);
}
`;

/**
 * 3. Digital Noise & Grain Fragment Shader
 * Simulates manga analog paper grain and vintage anime texture
 */
export const NOISE_GRAIN_FRAGMENT_SHADER = /* glsl */ `#version 300 es
precision highp float;

in vec2 v_texCoord;
out vec4 fragColor;

uniform sampler2D u_texture;
uniform float u_intensity;   // Noise strength (0.0 to 1.0)
uniform float u_grainSize;   // Grain scale factor (default: 1.0)
uniform float u_time;        // Dynamic time seed

// High-frequency pseudo-random hash
float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
}

void main() {
    vec4 base = texture(u_texture, v_texCoord);
    if (base.a <= 0.001) {
        fragColor = base;
        return;
    }

    vec2 grainCoord = floor(v_texCoord * 1024.0 / max(0.2, u_grainSize)) + fract(u_time);
    float noise = hash21(grainCoord) * 2.0 - 1.0;

    // Preserve luminance curve while applying grain
    vec3 grainedRgb = clamp(base.rgb + noise * (u_intensity * 0.35), 0.0, 1.0);
    fragColor = vec4(grainedRgb, base.a);
}
`;

/**
 * 4. Manga Halftone Dot Fragment Shader (漫畫風半色調網點)
 * Converts grayscale luminance into crisp, anti-aliased circular halftone screen tone dots
 */
export const HALFTONE_DOT_FRAGMENT_SHADER = /* glsl */ `#version 300 es
precision highp float;

in vec2 v_texCoord;
out vec4 fragColor;

uniform sampler2D u_texture;
uniform vec2 u_resolution;   // Canvas resolution in pixels
uniform float u_density;     // Dots per unit (LPI / frequency, e.g. 30..120)
uniform float u_angle;       // Screen angle in radians (classic manga standard: 45 deg = 0.785)
uniform float u_dotScale;    // Dot maximum diameter ratio (0.5 to 1.5)

void main() {
    // 1. Calculate screen coordinates
    vec2 p = v_texCoord * u_resolution;

    // 2. Rotate coordinate system by screen angle (u_angle)
    float cosA = cos(u_angle);
    float sinA = sin(u_angle);
    mat2 rot = mat2(cosA, -sinA, sinA, cosA);
    vec2 rotP = rot * p;

    // 3. Halftone cell grid
    float cellSize = max(2.0, u_resolution.x / max(1.0, u_density));
    vec2 cellId = floor(rotP / cellSize);
    vec2 cellCoord = fract(rotP / cellSize) - vec2(0.5);

    // 4. Sample image at the center of the cell
    mat2 invRot = mat2(cosA, sinA, -sinA, cosA);
    vec2 centerP = (cellId + vec2(0.5)) * cellSize;
    vec2 sampleCoord = (invRot * centerP) / u_resolution;
    vec4 sampleCol = texture(u_texture, clamp(sampleCoord, 0.0, 1.0));

    // Calculate perceptual luminance (ITU-R BT.601)
    float lum = dot(sampleCol.rgb, vec3(0.299, 0.587, 0.114));

    // Dot radius is inversely proportional to luminance (darker = bigger black dot)
    float maxRadius = 0.5 * clamp(u_dotScale, 0.5, 1.8);
    float dotRadius = maxRadius * sqrt(clamp(1.0 - lum, 0.0, 1.0));

    // Distance from center of current dot
    float dist = length(cellCoord);

    // Anti-aliased circle edge using fwidth
    float edgeSmooth = fwidth(dist) * 1.5;
    float dotAlpha = smoothstep(dotRadius + edgeSmooth, dotRadius - edgeSmooth, dist);

    // Halftone output: White paper with black/tone ink dots, tinted by original alpha
    vec3 toneColor = mix(vec3(1.0), vec3(0.08), dotAlpha);
    fragColor = vec4(toneColor, sampleCol.a);
}
`;

/**
 * 5. Chromatic Aberration / RGB Split Fragment Shader (色差分離)
 */
export const CHROMATIC_ABERRATION_FRAGMENT_SHADER = /* glsl */ `#version 300 es
precision highp float;

in vec2 v_texCoord;
out vec4 fragColor;

uniform sampler2D u_texture;
uniform vec2 u_offset;       // Directional offset vector in UV space
uniform float u_strength;    // Offset distance multiplier
uniform int u_radial;        // 1 for radial aberration from center, 0 for directional

void main() {
    vec2 splitVector = u_offset * u_strength;

    if (u_radial == 1) {
        vec2 fromCenter = v_texCoord - vec2(0.5);
        splitVector = fromCenter * u_strength * 0.05;
    }

    // Sample channels at displaced coordinates
    float r = texture(u_texture, v_texCoord - splitVector).r;
    vec4 g = texture(u_texture, v_texCoord);
    float b = texture(u_texture, v_texCoord + splitVector).b;

    fragColor = vec4(r, g.g, b, g.a);
}
`;

/**
 * 6. HSV / HSL Adjustment & Invert Fragment Shader
 */
export const HSV_ADJUST_FRAGMENT_SHADER = /* glsl */ `#version 300 es
precision highp float;

in vec2 v_texCoord;
out vec4 fragColor;

uniform sampler2D u_texture;
uniform float u_hue;         // Hue shift in degrees (-180..180)
uniform float u_saturation;  // Saturation multiplier (0.0 to 2.0)
uniform float u_brightness;  // Brightness offset (-1.0 to 1.0)
uniform int u_invert;        // 1 to invert colors, 0 otherwise

vec3 rgb2hsv(vec3 c) {
    vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
    vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
    vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));

    float d = q.x - min(q.w, q.y);
    float e = 1.0e-10;
    return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}

vec3 hsv2rgb(vec3 c) {
    vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
    vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
    return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

void main() {
    vec4 col = texture(u_texture, v_texCoord);
    if (col.a <= 0.0) {
        fragColor = col;
        return;
    }

    vec3 hsv = rgb2hsv(col.rgb);
    hsv.x = fract(hsv.x + u_hue / 360.0);
    hsv.y = clamp(hsv.y * u_saturation, 0.0, 1.0);
    hsv.z = clamp(hsv.z + u_brightness, 0.0, 1.0);

    vec3 outRgb = hsv2rgb(hsv);
    if (u_invert == 1) {
        outRgb = vec3(1.0) - outRgb;
    }

    fragColor = vec4(outRgb, col.a);
}
`;

/**
 * 7. Liquify Warp Distortion Fragment Shader (Push / Expand / Pinch)
 */
export const LIQUIFY_FRAGMENT_SHADER = /* glsl */ `#version 300 es
precision highp float;

in vec2 v_texCoord;
out vec4 fragColor;

uniform sampler2D u_texture;
uniform vec2 u_center;       // Normalized UV center of brush
uniform vec2 u_direction;    // Normalized push direction vector
uniform float u_radius;      // Normalized brush radius
uniform float u_strength;    // Warp strength
uniform int u_mode;          // 0: Push, 1: Expand, 2: Pinch

void main() {
    vec2 delta = v_texCoord - u_center;
    float dist = length(delta);

    vec2 warpedUV = v_texCoord;

    if (dist < u_radius && dist > 0.0001) {
        float falloff = pow(1.0 - (dist / u_radius), 2.0);

        if (u_mode == 0) {
            // Push mode
            warpedUV -= u_direction * falloff * u_strength * 0.05;
        } else if (u_mode == 1) {
            // Expand mode (magnify away from center)
            warpedUV -= normalize(delta) * falloff * u_strength * 0.03;
        } else if (u_mode == 2) {
            // Pinch mode (shrink toward center)
            warpedUV += normalize(delta) * falloff * u_strength * 0.03;
        }
    }

    fragColor = texture(u_texture, clamp(warpedUV, 0.0, 1.0));
}
`;

/**
 * 8. Real-time GPU Color Curves Fragment Shader (Bézier LUT)
 * Evaluates individual RGB channel curves and Master tone curves
 */
export const COLOR_CURVES_FRAGMENT_SHADER = /* glsl */ `#version 300 es
precision highp float;

in vec2 v_texCoord;
out vec4 fragColor;

uniform sampler2D u_texture;
uniform sampler2D u_curveLut; // 256x1 RGBA texture: R=Red, G=Green, B=Blue, A=Master LUT

void main() {
    vec4 col = texture(u_texture, v_texCoord);
    if (col.a <= 0.0) {
        fragColor = col;
        return;
    }

    // 1. Channel curves
    float curvedR = texture(u_curveLut, vec2(clamp(col.r, 0.0, 1.0), 0.5)).r;
    float curvedG = texture(u_curveLut, vec2(clamp(col.g, 0.0, 1.0), 0.5)).g;
    float curvedB = texture(u_curveLut, vec2(clamp(col.b, 0.0, 1.0), 0.5)).b;

    // 2. Master tone curve (alpha channel stores master curve)
    float finalR = texture(u_curveLut, vec2(curvedR, 0.5)).a;
    float finalG = texture(u_curveLut, vec2(curvedG, 0.5)).a;
    float finalB = texture(u_curveLut, vec2(curvedB, 0.5)).a;

    fragColor = vec4(finalR, finalG, finalB, col.a);
}
`;

/**
 * 9. Real-time GPU Gradient Map Fragment Shader (漸層對應)
 * Maps ITU-R BT.601 perceptual grayscale luminance onto a 256x1 gradient ramp
 */
export const GRADIENT_MAP_FRAGMENT_SHADER = /* glsl */ `#version 300 es
precision highp float;

in vec2 v_texCoord;
out vec4 fragColor;

uniform sampler2D u_texture;
uniform sampler2D u_gradientRamp; // 256x1 RGBA gradient ramp
uniform float u_opacity;

void main() {
    vec4 col = texture(u_texture, v_texCoord);
    if (col.a <= 0.0) {
        fragColor = col;
        return;
    }

    // ITU-R BT.601 perceptual luminance
    float lum = dot(col.rgb, vec3(0.299, 0.587, 0.114));
    vec4 gradCol = texture(u_gradientRamp, vec2(clamp(lum, 0.0, 1.0), 0.5));

    vec3 mixedRgb = mix(col.rgb, gradCol.rgb, clamp(u_opacity, 0.0, 1.0));
    fragColor = vec4(mixedRgb, col.a);
}
`;

