using Microsoft.Extensions.DependencyInjection;

namespace StoreMediaApi.V2;

public static class V2ServiceRegistration
{
    public static IServiceCollection AddV2Services(this IServiceCollection services)
    {
        // SCAFFOLD:V2_REPOSITORIES:START
        // SCAFFOLD:V2_REPOSITORIES:END
        return services;
    }
}
