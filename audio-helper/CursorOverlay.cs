// Desenha o ponteiro do mouse por cima da imagem capturada por DXGI Desktop Duplication.
// A duplicação entrega a tela SEM o cursor (ele vem à parte: forma + posição); o WGC desenhava sozinho.
using System.Runtime.InteropServices;
using Vortice.D3DCompiler;
using Vortice.Direct3D;
using Vortice.Direct3D11;
using Vortice.DXGI;
using Vortice.Mathematics;

sealed class CursorOverlay : IDisposable
{
    const string Shader = @"
Texture2D<float4> cur : register(t0);
SamplerState samp : register(s0);
cbuffer Params : register(b0) { float4 rect; };   // x0, y0, x1, y1 do cursor em coordenadas NDC
struct VSOut { float4 pos : SV_Position; float2 uv : TEXCOORD0; };

VSOut vs(uint id : SV_VertexID)
{
    VSOut o;
    o.uv = float2(id & 1, id >> 1);                       // 4 vértices (tira de triângulos)
    o.pos = float4(lerp(rect.xy, rect.zw, o.uv), 0, 1);
    return o;
}

float4 ps(VSOut i) : SV_Target
{
    return cur.Sample(samp, i.uv);
}";

    readonly ID3D11Device device;
    readonly ID3D11DeviceContext context;
    readonly ID3D11VertexShader vs;
    readonly ID3D11PixelShader ps;
    readonly ID3D11SamplerState sampler;
    readonly ID3D11BlendState blend;
    readonly ID3D11Buffer constants;
    ID3D11Texture2D? tex;
    ID3D11ShaderResourceView? srv;
    ID3D11RenderTargetView? rtv;
    ID3D11Texture2D? rtvTarget;
    int width, height, hotX, hotY;
    int posX, posY;
    bool visible;

    public CursorOverlay(ID3D11Device device, ID3D11DeviceContext context)
    {
        this.device = device;
        this.context = context;
        var vsCode = Compiler.Compile(Shader, "vs", "cursor", "vs_5_0");
        var psCode = Compiler.Compile(Shader, "ps", "cursor", "ps_5_0");
        vs = device.CreateVertexShader(vsCode.Span);
        ps = device.CreatePixelShader(psCode.Span);
        sampler = device.CreateSamplerState(SamplerDescription.PointClamp);
        blend = device.CreateBlendState(new BlendDescription(Blend.SourceAlpha, Blend.InverseSourceAlpha));
        constants = device.CreateBuffer(new BufferDescription(16, BindFlags.ConstantBuffer, ResourceUsage.Default));
    }

    /// Chamado a cada quadro em que o mouse mudou (posição e/ou forma).
    public unsafe void Update(IDXGIOutputDuplication dup, in OutduplFrameInfo info)
    {
        visible = info.PointerPosition.Visible;
        posX = info.PointerPosition.Position.X;
        posY = info.PointerPosition.Position.Y;
        if (info.PointerShapeBufferSize == 0) return;
        var buf = new byte[info.PointerShapeBufferSize];
        OutduplPointerShapeInfo shape;
        fixed (byte* p = buf)
        {
            if (dup.GetFramePointerShape(info.PointerShapeBufferSize, (IntPtr)p, out _, out shape).Failure) return;
        }
        try { BuildTexture(buf, shape); }
        catch (Exception ex) { Console.Error.WriteLine("[video] cursor: " + ex.Message); }
    }

    // Converte a forma do cursor para BGRA com transparência.
    // Pixels que "invertem a tela" (XOR) viram cinza opaco: aparecem tanto em fundo claro como escuro.
    unsafe void BuildTexture(byte[] buf, OutduplPointerShapeInfo shape)
    {
        int type = (int)shape.Type; // 1 = monocromático, 2 = colorido, 4 = colorido com máscara
        int w = (int)shape.Width;
        int h = type == 1 ? (int)shape.Height / 2 : (int)shape.Height;
        int pitch = (int)shape.Pitch;
        if (w <= 0 || h <= 0 || w > 512 || h > 512) return;
        var px = new byte[w * h * 4];
        for (int y = 0; y < h; y++)
        {
            for (int x = 0; x < w; x++)
            {
                int o = (y * w + x) * 4;
                if (type == 1)
                {
                    int bit = 7 - (x & 7);
                    bool and = ((buf[y * pitch + (x >> 3)] >> bit) & 1) != 0;
                    bool xor = ((buf[(y + h) * pitch + (x >> 3)] >> bit) & 1) != 0;
                    if (and && !xor) continue;                       // transparente
                    byte v = and ? (byte)128 : xor ? (byte)255 : (byte)0;
                    px[o] = v; px[o + 1] = v; px[o + 2] = v; px[o + 3] = 255;
                }
                else
                {
                    int s = y * pitch + x * 4;
                    if (type == 4 && buf[s + 3] == 0xFF) { px[o] = 128; px[o + 1] = 128; px[o + 2] = 128; px[o + 3] = 255; continue; }
                    px[o] = buf[s]; px[o + 1] = buf[s + 1]; px[o + 2] = buf[s + 2];
                    px[o + 3] = type == 4 ? (byte)255 : buf[s + 3];
                }
            }
        }
        srv?.Dispose(); tex?.Dispose(); srv = null; tex = null;
        fixed (byte* p = px)
        {
            tex = device.CreateTexture2D(new Texture2DDescription
            {
                Width = (uint)w, Height = (uint)h, MipLevels = 1, ArraySize = 1,
                Format = Format.B8G8R8A8_UNorm, SampleDescription = new SampleDescription(1, 0),
                Usage = ResourceUsage.Immutable, BindFlags = BindFlags.ShaderResource,
            }, new[] { new SubresourceData((IntPtr)p, (uint)(w * 4)) });
        }
        srv = device.CreateShaderResourceView(tex);
        width = w; height = h;
        hotX = shape.HotSpot.X; hotY = shape.HotSpot.Y;
    }

    /// Desenha o cursor em `target` (mesmo tamanho da tela duplicada). Chamar com a placa travada (gpuLock).
    public void Draw(ID3D11Texture2D target, int texW, int texH)
    {
        if (!visible || srv == null || texW <= 0 || texH <= 0) return;
        float x0 = posX - hotX, y0 = posY - hotY, x1 = x0 + width, y1 = y0 + height;
        if (x1 <= 0 || y1 <= 0 || x0 >= texW || y0 >= texH) return;
        if (!ReferenceEquals(rtvTarget, target))
        {
            rtv?.Dispose();
            rtv = device.CreateRenderTargetView(target);
            rtvTarget = target;
        }
        var ndc = new[] { x0 / texW * 2 - 1, 1 - y0 / texH * 2, x1 / texW * 2 - 1, 1 - y1 / texH * 2 };
        context.UpdateSubresource(ndc, constants);
        context.OMSetRenderTargets(rtv!);
        context.OMSetBlendState(blend);
        context.RSSetViewport(new Viewport(0, 0, texW, texH));
        context.IASetPrimitiveTopology(PrimitiveTopology.TriangleStrip);
        context.IASetInputLayout(null);
        context.VSSetShader(vs);
        context.PSSetShader(ps);
        context.VSSetConstantBuffer(0, constants);
        context.PSSetShaderResource(0, srv);
        context.PSSetSampler(0, sampler);
        context.Draw(4, 0);
        context.PSSetShaderResource(0, null!);
        context.OMSetBlendState((ID3D11BlendState?)null);
        context.OMSetRenderTargets((ID3D11RenderTargetView)null!);
    }

    /// A textura alvo foi recriada: a vista antiga não serve mais.
    public void ResetTarget() { rtv?.Dispose(); rtv = null; rtvTarget = null; }

    public void Dispose()
    {
        rtv?.Dispose(); srv?.Dispose(); tex?.Dispose();
        constants.Dispose(); blend.Dispose(); sampler.Dispose(); ps.Dispose(); vs.Dispose();
    }
}
