using Microsoft.AspNetCore.Builder;
using Microsoft.Extensions.DependencyInjection;

namespace AcmeCorp.Api;

public static class Program
{
    public static void Main(string[] args)
    {
        var builder = WebApplication.CreateBuilder(args);

        // SCAFFOLD:DI:START
builder.Services.AddScoped<IInvoiceService, InvoiceService>();

// scaffold-hash:e0a80c838ae6981b35f4b282309fb3189123540e873757514ec54e22bdc08fa2
        // SCAFFOLD:DI:END

        var app = builder.Build();

        // SCAFFOLD:ROUTES:START
app.MapGet("/api/Invoices", () => Results.Ok());

// scaffold-hash:431ccea739dc0eb7b64676741543db855f1e82f779dbdfb78131585b0a2798fe
        // SCAFFOLD:ROUTES:END

        app.Run();
    }
}
