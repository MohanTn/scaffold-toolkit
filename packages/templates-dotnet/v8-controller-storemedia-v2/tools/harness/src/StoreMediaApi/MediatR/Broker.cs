using Microsoft.Extensions.DependencyInjection;

namespace StoreMediaApi.MediatR;

public class Broker : IBroker
{
    private readonly IServiceProvider _serviceProvider;

    public Broker(IServiceProvider serviceProvider)
    {
        _serviceProvider = serviceProvider;
    }

    public Task<TResult> SendAsync<TResult>(ICommand<TResult> command, CancellationToken cancellationToken = default)
    {
        var handlerType = typeof(ICommandHandler<,>).MakeGenericType(command.GetType(), typeof(TResult));
        dynamic handler = _serviceProvider.GetRequiredService(handlerType);
        return handler.HandleAsync((dynamic)command, cancellationToken);
    }

    public Task<TResult> SendAsync<TResult>(IQuery<TResult> query, CancellationToken cancellationToken = default)
    {
        var handlerType = typeof(IQueryHandler<,>).MakeGenericType(query.GetType(), typeof(TResult));
        dynamic handler = _serviceProvider.GetRequiredService(handlerType);
        return handler.HandleAsync((dynamic)query, cancellationToken);
    }
}
