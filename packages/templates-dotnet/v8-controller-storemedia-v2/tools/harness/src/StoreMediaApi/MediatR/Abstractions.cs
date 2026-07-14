namespace StoreMediaApi.MediatR;

/// <summary>Marker for the assembly the Broker scans for handlers.</summary>
public interface IAssemblyMarker
{
}

public interface ICommand<TResult>
{
}

public interface IQuery<TResult>
{
}

public interface ICommandHandler<in TCommand, TResult>
    where TCommand : ICommand<TResult>
{
    Task<TResult> HandleAsync(TCommand command, CancellationToken cancellationToken);
}

public interface IQueryHandler<in TQuery, TResult>
    where TQuery : IQuery<TResult>
{
    Task<TResult> HandleAsync(TQuery query, CancellationToken cancellationToken);
}

public interface IBroker
{
    Task<TResult> SendAsync<TResult>(ICommand<TResult> command, CancellationToken cancellationToken = default);

    Task<TResult> SendAsync<TResult>(IQuery<TResult> query, CancellationToken cancellationToken = default);
}
