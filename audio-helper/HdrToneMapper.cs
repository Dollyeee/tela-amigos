// Converte a captura HDR (scRGB, ponto flutuante 16 bits) em SDR (BGRA 8 bits) na placa de vídeo.
// - divide pelo "branco SDR" do Windows: o que é branco no desktop vira branco na transmissão
// - brilhos acima disso são comprimidos suavemente (em vez de estourar)
// - cores fora do sRGB são cortadas (sem tons negativos); depois aplica a curva sRGB
using System.Runtime.InteropServices;
using Vortice.D3DCompiler;
using Vortice.Direct3D;
using Vortice.Direct3D11;
using Vortice.DXGI;
using Vortice.Mathematics;

sealed class HdrToneMapper : IDisposable
{
    const string Shader = @"
Texture2D<float4> src : register(t0);
SamplerState samp : register(s0);
cbuffer Params : register(b0) { float white; float knee; float2 pad; };
struct VSOut { float4 pos : SV_Position; float2 uv : TEXCOORD0; };

VSOut vs(uint id : SV_VertexID)
{
    VSOut o;
    o.uv = float2((id << 1) & 2, id & 2);
    o.pos = float4(o.uv * float2(2, -2) + float2(-1, 1), 0, 1);
    return o;
}

float3 srgb(float3 l)
{
    float3 lo = 12.92 * l;
    float3 hi = 1.055 * pow(max(l, 1e-6), 1.0 / 2.4) - 0.055;
    return lerp(hi, lo, step(l, 0.0031308));
}

float4 ps(VSOut i) : SV_Target
{
    float3 c = max(src.Sample(samp, i.uv).rgb / white, 0);   // 1,0 = branco do desktop
    float m = max(max(c.r, c.g), c.b);
    if (m > knee)
    {
        // acima do joelho: comprime para nunca passar de 1,0 (sem estourar os brilhos)
        float mapped = knee + (1 - knee) * (1 - exp(-(m - knee) / (1 - knee)));
        c *= mapped / m;
    }
    return float4(srgb(saturate(c)), 1);
}";

    readonly ID3D11Device device;
    readonly ID3D11DeviceContext context;
    readonly ID3D11VertexShader vs;
    readonly ID3D11PixelShader ps;
    readonly ID3D11SamplerState sampler;
    readonly ID3D11Buffer constants;
    ID3D11Texture2D? output;
    ID3D11RenderTargetView? rtv;
    ID3D11ShaderResourceView? srv;
    ID3D11Texture2D? srvSource;
    int outW, outH;

    public ID3D11Texture2D? Output => output;

    public HdrToneMapper(ID3D11Device device, ID3D11DeviceContext context, float sdrWhiteScale)
    {
        this.device = device;
        this.context = context;
        var vsCode = Compiler.Compile(Shader, "vs", "tonemap", "vs_5_0");
        var psCode = Compiler.Compile(Shader, "ps", "tonemap", "ps_5_0");
        vs = device.CreateVertexShader(vsCode.Span);
        ps = device.CreatePixelShader(psCode.Span);
        sampler = device.CreateSamplerState(SamplerDescription.LinearClamp);
        var p = new float[] { sdrWhiteScale, 0.75f, 0, 0 };
        constants = device.CreateBuffer(p, new BufferDescription(16, BindFlags.ConstantBuffer, ResourceUsage.Immutable));
    }

    /// Converte `source` (HDR) para a textura de saída (SDR) do mesmo tamanho.
    public void Process(ID3D11Texture2D source, int width, int height)
    {
        if (output == null || outW != width || outH != height)
        {
            rtv?.Dispose(); output?.Dispose();
            output = device.CreateTexture2D(new Texture2DDescription
            {
                Width = (uint)width, Height = (uint)height, MipLevels = 1, ArraySize = 1,
                Format = Format.B8G8R8A8_UNorm, SampleDescription = new SampleDescription(1, 0),
                Usage = ResourceUsage.Default, BindFlags = BindFlags.RenderTarget | BindFlags.ShaderResource,
            });
            rtv = device.CreateRenderTargetView(output);
            outW = width; outH = height;
        }
        if (srvSource != source)
        {
            srv?.Dispose();
            srv = device.CreateShaderResourceView(source);
            srvSource = source;
        }
        context.OMSetRenderTargets(rtv!);
        context.RSSetViewport(new Viewport(0, 0, width, height));
        context.IASetPrimitiveTopology(PrimitiveTopology.TriangleList);
        context.IASetInputLayout(null);
        context.VSSetShader(vs);
        context.PSSetShader(ps);
        context.PSSetShaderResource(0, srv!);
        context.PSSetSampler(0, sampler);
        context.PSSetConstantBuffer(0, constants);
        context.Draw(3, 0);
        // solta as ligações (a mesma textura vai ser usada como entrada do VideoProcessor)
        context.PSSetShaderResource(0, null!);
        context.OMSetRenderTargets((ID3D11RenderTargetView)null!);
    }

    /// A textura de entrada mudou (janela redimensionada): a vista antiga não serve mais.
    public void ResetSource() { srv?.Dispose(); srv = null; srvSource = null; }

    public void Dispose()
    {
        srv?.Dispose(); rtv?.Dispose(); output?.Dispose();
        constants.Dispose(); sampler.Dispose(); ps.Dispose(); vs.Dispose();
    }
}
